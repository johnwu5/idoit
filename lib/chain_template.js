'use strict';


const inherits     = require('util').inherits;

const TaskTemplate = require('./task_template');
const Command      = require('./command');
const utils        = require('./utils');


function ChainTemplate(queue, ...args) {
  // Temporary child instances store for init/prepare methods
  this.__children_to_init__ = [];

  // This code can be called in 3 ways:
  //
  // 1. Direct run as `queue.chain([ subtask1, subtask2, ...])
  // 2. From inherited task, extended via class/prototype
  // 3. From inherited task, quick-extended via .init() override
  //
  // We need 2 things:
  //
  // - Keep this.args serializeable
  // - Prepare list of children to init
  //
  // So, we just check content of first params, to decide what to do.
  // That's a bit dirty, but good enougth. If user need some very
  // specific signature in inherited task, he can always customize data after
  // parent (this) constructor call
  //
  if (Array.isArray(args[0]) && args[0].length && args[0][0] instanceof TaskTemplate) {
    // If we are here - assume user called `queue.chain([ subtask1, ...])`
    this.__children_to_init__ = args[0];
    args[0] = null;
  }

  TaskTemplate.call(this, queue, ...args);
}


inherits(ChainTemplate, TaskTemplate);


// (internal) Prepare task prior to run. Used to modify templates
// behaviour on inherit.
//
// !!! Don't touch this method, override `.init()` to extend
// registered tasks.
//
ChainTemplate.prototype.prepare = async function () {
  this.id = this.taskID();

  // .init() can be simple sync function
  // Specially for group & chain templates - it can return
  // list of children to init.
  let _children = await Promise.resolve().then(() => this.init());

  if (Array.isArray(_children)) this.__children_to_init__ = _children;


  if (!this.__children_to_init__.length) {
    return Promise.reject(new Error('ido error: you should specify chain children'));
  }

  this.children          = [];
  this.children_finished = 0;
  this.total             = 0;

  // Initialize children, link to parent & count progress total
  return Promise.all(this.__children_to_init__).then(() => {
    this.__children_to_init__.forEach(t => {
      this.total  += t.total;
      t.setParent(this);

      this.children.push(t.id);
    });
  });
};


// Handle `activate` command
//
// - move chain from `waiting` to `idle`
// - send `activate` command to first child
//
ChainTemplate.prototype.handleCommand_activate = async function (command) {
  let prefix   = this.queue.__prefix__;
  let time     = utils.redisToMs(await this.queue.__redis__.timeAsync());

  let rawChild = await this.queue.__getRawTask__(this.children[0]);

  let transaction = {
    validate: [
      [ 1, [ 'zrem', `${prefix}${this.pool}:commands_locked`, command.toJSON() ] ],
      [ JSON.stringify('waiting'), [ 'hget', `${prefix}${this.id}`, 'state' ] ]
    ],
    exec: [
      // Move this task to `idle` and update state
      [ 'srem', `${prefix}waiting`, this.id ],
      [ 'sadd', `${prefix}idle`, this.id ],
      [ 'hset', `${prefix}${this.id}`, 'state', JSON.stringify('idle') ]
    ]
  };

  // Send `activate` command to first child
  if (rawChild) {
    transaction.exec.push([
      'zadd',
      `${prefix}${rawChild.pool}:commands`,
      time,
      Command.fromObject({ to: rawChild.id, to_uid: rawChild.uid, type: 'activate' }).toJSON()
    ]);
  }

  await this.queue.__redis__.evalAsync(this.queue.__scripts__.transaction, 1, JSON.stringify(transaction));
};


// Handle child result
//
ChainTemplate.prototype.handleCommand_result =  async function (command) {
  let prefix = this.queue.__prefix__;
  let time   = utils.redisToMs(await this.queue.__redis__.timeAsync());


  // Run next children task
  //
  if (this.children_finished + 1 < this.children.length) {
    let childID  = this.children[this.children_finished + 1];

    let rawChild = await this.queue.__getRawTask__(childID);

    let transaction = {
      validate: [
        [ 1, [ 'zrem', `${prefix}${this.pool}:commands_locked`, command.toJSON() ] ],
        [ JSON.stringify('idle'), [ 'hget', `${prefix}${this.id}`, 'state' ] ]
      ],
      exec: [
        // Increment `children_finished`
        [ 'hincrby', `${prefix}${this.id}`, 'children_finished', 1 ]
      ]
    };

    // Send `activate` command to child
    if (rawChild) {
      transaction.exec.push([
        'zadd',
        `${prefix}${rawChild.pool}:commands`,
        time,
        Command.fromObject({ to: childID, to_uid: rawChild.uid, type: 'activate' }).toJSON()
      ]);
    }

    // Merge child args
    if (command.data.result) {
      let childArgs = JSON.parse(await this.queue.__redis__.hgetAsync(`${prefix}${childID}`, 'args'));
      let newArgs   = childArgs.concat([ command.data.result ]);

      transaction.exec.push([ 'hset', `${prefix}${childID}`, 'args', JSON.stringify(newArgs) ]);
    }

    await this.queue.__redis__.evalAsync(this.queue.__scripts__.transaction, 1, JSON.stringify(transaction));
    return;
  }


  // Finish chain
  //
  let transaction = {
    validate: [
      [ 1, [ 'zrem', `${prefix}${this.pool}:commands_locked`, command.toJSON() ] ],
      [ JSON.stringify('idle'), [ 'hget', `${prefix}${this.id}`, 'state' ] ]
    ],
    exec: [
      // Increment `children_finished`
      [ 'hincrby', `${prefix}${this.id}`, 'children_finished', 1 ],

      // Move this task to `finished` and update state
      [ 'srem', `${prefix}idle`, this.id ],
      [ 'zadd', `${prefix}finished`, this.removeDelay + time, this.id ],
      [ 'hset', `${prefix}${this.id}`, 'state', JSON.stringify('finished') ],

      // Set progress
      [ 'hset', `${prefix}${this.id}`, 'progress', this.total ]
    ]
  };

  // Save result
  if (typeof command.data.result !== 'undefined') {
    transaction.exec.push([ 'hset', `${prefix}${this.id}`, 'result', JSON.stringify(command.data.result) ]);
  }

  if (this.parent) {
    // Send command with result to parent
    transaction.exec.push([ 'zadd', `${prefix}${this.parent_pool}:commands`, time, Command.fromObject({
      to:     this.parent,
      to_uid: this.parent_uid,
      type:   'result',
      data:   { id: this.id, result: command.data.result }
    }).toJSON() ]);
  }

  let success = await this.queue.__redis__.evalAsync(
    this.queue.__scripts__.transaction,
    1,
    JSON.stringify(transaction)
  );

  if (success) {
    let eventData = { id: this.id, uid: this.uid };

    this.queue.emit('task:end', eventData);
    this.queue.emit(`task:end:${this.id}`, eventData);
  }
};


ChainTemplate.serializableFields = TaskTemplate.serializableFields.concat([
  'children',
  'children_finished'
]);


// Task class factory
//
ChainTemplate.extend = function (options) {
  class T extends ChainTemplate {}

  Object.assign(T.prototype, options);

  return T;
};


module.exports = ChainTemplate;
