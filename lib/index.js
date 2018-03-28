"use strict";

// Module Requirements
var _ = require('lodash'),
    proc = require('child_process'),
    join = require('path').join,
    async = require('async'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    streamBuffers = require("stream-buffers"),
    through = require('through'),
    split = require('split'),
    fs = require('fs');

require('colors');

function newStreamBuffer() {
  var stream = new streamBuffers.WritableStreamBuffer({
      initialSize: (25 * 1024),
      incrementAmount: (10 * 1024)
  });
  return stream;
}

var SpawnMocha = function (opts) {
  var _this = this;
  opts = opts || {};
  var queue = async.queue(function (task, done) {
    // Setup
    var bin = _.isFunction(opts.bin) ? opts.bin() : opts.bin ||
      join(__dirname, '..', 'node_modules', '.bin', 'mocha');
    var env = _.isFunction(opts.env) ? opts.env(task) : opts.env || process.env;
    env = _.clone(env);

    // Generate arguments
    var args = [];

    _(opts.flags).each(function (val, key) {
      if(_.isFunction(val)) val = val();
      args.push((key.length > 1 ? '--' : '-') + key);
      if (_.isString(val) || _.isNumber(val)) {
        args.push(val);
      }
    }).value();

    const merged = newStreamBuffer();
    const stdout = newStreamBuffer();
    const stderr = newStreamBuffer();

    // Execute Mocha
    const child = proc.spawn(bin, args.concat(task.files), {env: env});

    child.stdout.pipe(merged);
    child.stderr.pipe(merged);

    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);

    // When done...
    child.on('close', function(errCode) {
      const mergedContents = merged.size() ? merged.getContentsAsString("utf8") : '';
      const errContents = stderr.size() ? stderr.getContentsAsString("utf8") : '';
      const outContents = stdout.size() ? stdout.getContentsAsString("utf8") : '';

      // emit test file data at the end
      _this.emit('data', { task, merged: mergedContents, stderr: errContents, stdout: outContents });
      let err = null;

      if(errCode) {
        const message = `Error for file ${task.files.join(', ')}`;
        err = new Error();
        err.exitCode = errCode;
        err.files = task.files;
        err.stderr = errContents;
        // err.stdout = outContents;
        // err.merged = mergedContents;
        err.code = errCode;
      }

      done(err);
    });
  }, opts.concurrency || 1);

  queue.drain = function() {
    _this.emit('end');
  };

  var taskNum = 0;
  this.add = function(files) {
    taskNum ++;
    if (!_.isArray(files)) {
      files = [files];
    }
    var task = {taskNum: taskNum, files: files};
    queue.push(task, function(err) {
      if(err){
        _this.emit('error', err, files);
      }
    });
  };
};

util.inherits(SpawnMocha, EventEmitter);

var mochaStream = function mocha(opts) {
  opts = _.merge({}, opts, {
    inspect: true, // TODO: not sure if this argument works
    flags: {
      reporter: 'mocha-circleci-reporter',
      reporterOptions: 'includePending=true',
    },
  });

  var spawnMocha = new SpawnMocha(opts);
  var stream = through(function write(file) {
    spawnMocha.add(file.path);
  }, function() {});
  var errors = [];
  spawnMocha.on('data', function(testFileData) {
    console.log(testFileData.merged);
    stream.emit('data', testFileData);
  });
  spawnMocha.on('error', function(err) {
    errors.push(err);
  });
  spawnMocha.on('end', function() {
    if(errors.length > 0) {
      _(errors).each(function(err) {
        // error in spec files
        if (err.stderr) {
          console.error(`Errors for file ${err.files.join(', ')}`);
          console.error(err.stderr);
        // error outside spec files
        } else {
          console.error(err.stack);
        }
      }).value();
      stream.emit('error', errors);
    }
    stream.emit('end');
  });
  return stream;
};

module.exports = {
  SpawnMocha: SpawnMocha,
  mochaStream: mochaStream
};
