import fs, { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path, {
  isAbsolute,
  dirname,
  resolve as pathResolve,
  join as pathJoin,
} from 'node:path';
import os from 'node:os';
import EventEmitter from 'node:events';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import _ from 'lodash';
import semver from 'semver';
import { readPackageUpSync } from 'read-pkg-up';
import chalk from 'chalk';
import minimist from 'minimist';
import createDebug from 'debug';
import memFsEditor from 'mem-fs-editor';

import Storage from './util/storage.js';
import promptSuggestion from './util/prompt-suggestion.js';
import helpMixin from './actions/help.js';
import spawnCommandMixin from './actions/spawn-command.js';
import fsMixin from './actions/fs.js';
import packageJsonMixin from './actions/package-json.js';
import userMixin from './actions/user.js';
import { DESTINATION_ROOT_CHANGE_EVENT } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EMPTY = '@@_YEOMAN_EMPTY_MARKER_@@';
const debug = createDebug('yeoman:generator');
const ENV_VER_WITH_VER_API = '2.9.0';
const packageJson = JSON.parse(
  readFileSync(pathJoin(__dirname, '../package.json'), 'utf8'),
);

// eslint-disable-next-line unicorn/no-array-reduce
const Base = [packageJsonMixin, spawnCommandMixin].reduce(
  (a, b) => b(a),
  EventEmitter,
);

// Ensure a prototype method is a candidate run by default
const methodIsValid = function (name) {
  return name.charAt(0) !== '_' && name !== 'constructor';
};

/**
 * Queue options.
 * @typedef {Object} QueueOptions
 * @property {string} [queueName] - Name of the queue.
 * @property {boolean} [once] - Execute only once by namespace and taskName.
 * @property {boolean} [run] - Run the queue if not running yet.
 */

/**
 * Task options.
 * @typedef {QueueOptions} TaskOptions
 * @property {Function} [reject] - Reject callback.
 */

/**
 * Priority object.
 * @typedef {QueueOptions} Priority
 * @property {string} priorityName - Name of the priority.
 * @property {string} [before] - The queue which this priority should be added before.
 */

/**
 * Complete Task object.
 * @typedef {TaskOptions} Task
 * @property {Function} method - Function to be queued.
 * @property {string} taskName - Name of the task.
 */

export class BaseGenerator extends Base {
  // If for some reason environment adds more queues, we should use or own for stability.
  static get queues() {
    return [
      'initializing',
      'prompting',
      'configuring',
      'default',
      'writing',
      'transform',
      'conflicts',
      'install',
      'end',
    ];
  }

  /**
   * @classdesc The `Generator` class provides the common API shared by all generators.
   * It define options, arguments, file, prompt, log, API, etc.
   *
   * It mixes into its prototype all the methods found in the `actions/` mixins.
   *
   * Every generator should extend this base class.
   *
   * @constructor
   * @augments actions/package-json
   * @mixes actions/help
   * @mixes actions/spawn-command
   * @mixes actions/user
   * @mixes actions/fs
   * @mixes nodejs/EventEmitter
   *
   * @param {string[]} args           - Provide arguments at initialization
   * @param {Object} options          - Provide options at initialization
   * @param {Priority[]} [options.customPriorities] - Custom priorities
   * @property {Object}   env         - the current Environment being run
   * @property {String}   resolved    - the path to the current generator
   * @property {String}   description - Used in `--help` output
   * @property {String}   appname     - The application name
   * @property {Storage}  config      - `.yo-rc` config file manager
   * @property {Object}   fs          - An instance of {@link https://github.com/SBoudrias/mem-fs-editor Mem-fs-editor}
   * @property {Function} log         - Output content through Interface Adapter
   * @param {Object} features         - Provide Generator features information
   * @property {String}   uniqueBy    - The Generator instance unique identifier.
   *                                    The Environment will ignore duplicated identifiers.
   * @property {String}   unique      - uniqueBy calculation method (undefined/argument/namespace)
   * @property {boolean} tasksMatchingPriority - Only queue methods that matches a priority.
   * @property {String}   taskPrefix  - Tasks methods starts with prefix. Allows api methods (non tasks) without prefix.
   * @property {boolean|Function} customInstallTask - Provides a custom install task. Environment >= 3.2.0
   *                                                  Environment built-in task will not be executed
   * @property {boolean|Function} customCommitTask - Provides a custom commit task. Environment >= 3.2.0
   *                                                  Environment built-in task will not be executed
   *
   * @example
   * import Generator from 'yeoman-generator';
   * module.exports = class extends Generator {
   *   writing() {
   *     this.fs.write(this.destinationPath('index.js'), 'const foo = 1;');
   *   }
   * };
   */
  constructor(args, options, features) {
    super();

    if (!Array.isArray(args)) {
      features = options;
      options = args;
      args = [];
    }

    Object.defineProperty(this, 'yoGeneratorVersion', {
      value: packageJson.version,
      writable: false,
    });

    options = options || {};
    this.options = options;
    this._initOptions = _.clone(options);
    this._args = args || [];
    this._options = {};
    this._arguments = [];
    this._prompts = [];
    this._composedWith = [];
    this._namespace = this.options.namespace;
    this._namespaceId = this.options.namespaceId;
    this.features = features || { unique: this.options.unique };

    this.option('help', {
      type: Boolean,
      alias: 'h',
      description: "Print the generator's options and usage",
    });

    this.option('skip-cache', {
      type: Boolean,
      description: 'Do not remember prompt answers',
      default: false,
    });

    this.option('skip-install', {
      type: Boolean,
      description: 'Do not automatically install dependencies',
      default: false,
    });

    this.option('force-install', {
      type: Boolean,
      description: 'Fail on install dependencies error',
      default: false,
    });

    this.option('ask-answered', {
      type: Boolean,
      description: 'Show prompts for already configured options',
      default: false,
    });

    this.env = this.options.env;

    this.resolved = this.options.resolved || fileURLToPath(import.meta.url);
    this.description = this.description || '';

    if (this.env) {
      // Determine the app root
      this.contextRoot = this.env.cwd;
      this.destinationRoot(this.options.destinationRoot || this.env.cwd);
      // Clear destionationRoot, _destinationRoot will take priority when composing, but not override passed options.
      delete this.options.destinationRoot;

      // Ensure source/destination path, can be configured from subclasses
      this.sourceRoot(path.join(path.dirname(this.resolved), 'templates'));

      this.fs = memFsEditor.create(this.env.sharedFs);
    }

    // Add convenience debug object
    this._debug = createDebug(
      this.options.namespace || 'yeoman:unknownnamespace',
    );

    // Expose utilities for dependency-less generators.
    this._ = _;

    if (this.options.help) {
      return;
    }

    if (this.features.unique && !this.features.uniqueBy) {
      const { namespace } = this.options;
      let uniqueBy;
      if (
        this.features.unique === true ||
        this.features.unique === 'namespace'
      ) {
        uniqueBy = namespace;
      } else if (
        this.features.unique === 'argument' &&
        this._args.length === 1
      ) {
        const namespaceId = this.env
          .requireNamespace(namespace)
          .with({ instanceId: this._args[0] });
        uniqueBy = namespaceId.id;
      } else {
        throw new Error(
          `Error generating a uniqueBy value. Uniqueness '${this.features.unique}' not supported by '${this.options.namespace}'`,
        );
      }

      this.features.uniqueBy = uniqueBy;
    }

    if (!this.env) {
      throw new Error('This generator requires an environment.');
    }

    // Ensure the environment support features this yeoman-generator version require.
    if (
      !this.env ||
      !this.env.adapter ||
      !this.env.runLoop ||
      !this.env.sharedFs
    ) {
      throw new Error(
        "Current environment doesn't provides some necessary feature this generator needs.",
      );
    }

    // Mirror the adapter log method on the generator.
    //
    // example:
    // this.log('foo');
    // this.log.error('bar');
    this.log = this.env.adapter && this.env.adapter.log;

    this.appname = this.determineAppname();

    // Create config for the generator and instance
    if (this._namespaceId && this._namespaceId.generator) {
      this.generatorConfig = this.config.createStorage(
        `:${this._namespaceId.generator}`,
      );
      if (this._namespaceId.instanceId) {
        this.instanceConfig = this.generatorConfig.createStorage(
          `#${this._namespaceId.instanceId}`,
        );
      }
    }

    this._globalConfig = this._getGlobalStorage();

    // Queues map: generator's queue name => grouped-queue's queue name (custom name)
    this._queues = {};

    // Add original queues.
    for (const queue of Generator.queues) {
      this._queues[queue] = { priorityName: queue, queueName: queue };
    }

    // Add custom queues
    if (Array.isArray(this.options.customPriorities)) {
      this.registerPriorities(this.options.customPriorities);
    }

    this.compose = this.options.compose;

    this.checkEnvironmentVersion('3.12.1', this.options.skipCheckEnv);
  }

  /**
   * Configure Generator behaviours.
   *
   * @param {Object} features
   * @param {boolean|string} [features.unique] - Generates a uniqueBy id for the environment
   *                                    Accepts 'namespace' or 'true' for one instance by namespace
   *                                    Accepts 'argument' for one instance by namespace and 1 argument
   *
   */
  setFeatures(features) {
    Object.assign(this.features, features);
  }

  /**
   * Specifications for Environment features.
   *
   * @return {Object}
   */
  getFeatures() {
    return this.features;
  }

  /**
   * Register priorities for this generator
   *
   * @param  {Object[]} priorities - Priorities
   * @param  {String} priorities.priorityName - Priority name
   * @param  {String} [priorities.before] - The new priority will be queued before the `before` priority. Required for new priorities.
   * @param  {String} [priorities.queueName] - Name to be used at grouped-queue
   * @param  {boolean} [priorities.edit] - Edit a priority
   * @param  {boolean} [priorities.skip] - Queued manually only
   * @param  {Object[]|function} [priorities.args] - Arguments to pass to tasks
   */
  registerPriorities(priorities) {
    priorities = priorities.filter(priority => {
      if (priority.edit) {
        const queue = this._queues[priority.priorityName];
        if (!queue) {
          throw new Error(
            `Error editing priority ${priority.priorityName}, not found`,
          );
        }

        Object.assign(queue, { ...priority, edit: undefined });
      }

      return !priority.edit;
    });
    const customPriorities = priorities.map(customPriority => {
      // Keep backward compatibility with name
      const newPriority = {
        priorityName: customPriority.name,
        ...customPriority,
      };
      delete newPriority.name;
      return newPriority;
    });

    // Sort customPriorities, a referenced custom queue must be added before the one that reference it.
    customPriorities.sort((a, b) => {
      if (a.priorityName === b.priorityName) {
        throw new Error(`Duplicate custom queue ${a.name}`);
      }

      if (a.priorityName === b.before) {
        return -1;
      }

      if (b.priorityName === a.before) {
        return 1;
      }

      return 0;
    });

    // Add queue to runLoop
    for (const customQueue of customPriorities) {
      customQueue.queueName =
        customQueue.queueName ||
        `${this.options.namespace}#${customQueue.priorityName}`;
      debug(`Registering custom queue ${customQueue.queueName}`);
      this._queues[customQueue.priorityName] = customQueue;

      if (this.env.runLoop.queueNames.includes(customQueue.queueName)) {
        continue;
      }

      const beforeQueue = customQueue.before
        ? this._queues[customQueue.before].queueName
        : undefined;
      this.env.runLoop.addSubQueue(customQueue.queueName, beforeQueue);
    }
  }

  checkEnvironmentVersion(packageDependency, version, warning = false) {
    if (typeof version === 'boolean') {
      warning = version;
      version = undefined;
    }

    if (version === undefined) {
      version = packageDependency;
      packageDependency = 'yeoman-environment';
    }

    version = version || ENV_VER_WITH_VER_API;
    const returnError = currentVersion => {
      return new Error(
        `This generator (${this.options.namespace}) requires ${packageDependency} at least ${version}, current version is ${currentVersion}, try reinstalling latest version of 'yo' or use '--ignore-version-check' option`,
      );
    };

    if (!this.env.getVersion) {
      if (!this.options.ignoreVersionCheck && !warning) {
        throw returnError(`less than ${ENV_VER_WITH_VER_API}`);
      }

      console.warn(
        `It's not possible to check version with running Environment less than ${ENV_VER_WITH_VER_API}`,
      );
      console.warn('Some features may be missing');
      if (semver.lte(version, '2.8.1')) {
        return undefined;
      }

      return false;
    }

    const runningVersion = this.env.getVersion(packageDependency);
    if (runningVersion !== undefined && semver.lte(version, runningVersion)) {
      return true;
    }

    if (this.options.ignoreVersionCheck || warning) {
      console.warn(
        `Current ${packageDependency} is not compatible with current generator, min required: ${version} current version: ${runningVersion}. Some features may be missing, try updating reinstalling 'yo'.`,
      );
      return false;
    }

    throw returnError(runningVersion);
  }

  /**
   * Convenience debug method
   *
   * @param  {any} args parameters to be passed to debug
   */
  debug(...args) {
    this._debug(...args);
  }

  /**
   * Register stored config prompts and optional option alternative.
   *
   * @param {Inquirer|Inquirer[]} questions - Inquirer question or questions.
   * @param {Object|Boolean} [questions.exportOption] - Additional data to export this question as an option.
   * @param {Storage|String} [question.storage=this.config] - Storage to store the answers.
   */
  registerConfigPrompts(questions) {
    questions = Array.isArray(questions) ? questions : [questions];
    const getOptionTypeFromInquirerType = type => {
      if (type === 'number') {
        return Number;
      }

      if (type === 'confirm') {
        return Boolean;
      }

      if (type === 'checkbox') {
        return Array;
      }

      return String;
    };

    for (const q of questions) {
      const question = { ...q };
      if (q.exportOption) {
        const option =
          typeof q.exportOption === 'boolean' ? {} : q.exportOption;
        this.option({
          name: q.name,
          type: getOptionTypeFromInquirerType(q.type),
          description: q.message,
          ...option,
          storage: q.storage || this.config,
        });
      }

      this._prompts.push(question);
    }
  }

  /**
   * Prompt user to answer questions. The signature of this method is the same as {@link https://github.com/SBoudrias/Inquirer.js Inquirer.js}
   *
   * On top of the Inquirer.js API, you can provide a `{store: true}` property for
   * every question descriptor. When set to true, Yeoman will store/fetch the
   * user's answers as defaults.
   *
   * @param  {object|object[]} questions  Array of question descriptor objects. See {@link https://github.com/SBoudrias/Inquirer.js/blob/master/README.md Documentation}
   * @param  {Storage|String} [questions.storage] Storage object or name (generator property) to be used by the question to store/fetch the response.
   * @param  {Storage|String} [storage] Storage object or name (generator property) to be used by default to store/fetch responses.
   * @return {Promise} prompt promise
   */
  prompt(questions, storage) {
    const checkInquirer = () => {
      if (this.inquireSupportsPrefilled === undefined) {
        this.checkEnvironmentVersion();
        this.inquireSupportsPrefilled = this.checkEnvironmentVersion(
          'inquirer',
          '7.1.0',
        );
      }
    };

    if (storage !== undefined) {
      checkInquirer();
    }

    const storageForQuestion = {};

    const getAnswerFromStorage = question => {
      let questionStorage = question.storage || storage;
      questionStorage =
        typeof questionStorage === 'string'
          ? this[questionStorage]
          : questionStorage;
      if (questionStorage) {
        checkInquirer();

        const { name } = question;
        storageForQuestion[name] = questionStorage;
        const value = questionStorage.getPath(name);
        if (value !== undefined) {
          question.default = answers => answers[name];
          return [name, value];
        }
      }

      return undefined;
    };

    if (!Array.isArray(questions)) {
      questions = [questions];
    }

    // Shows the prompt even if the answer already exists.
    for (const question of questions) {
      if (question.askAnswered === undefined) {
        question.askAnswered = this.options.askAnswered === true;
      }
    }

    questions = promptSuggestion.prefillQuestions(
      this._globalConfig,
      questions,
    );
    questions = promptSuggestion.prefillQuestions(this.config, questions);
    const answers = Object.fromEntries(
      questions.map(getAnswerFromStorage).filter(Boolean),
    );

    return this.env.adapter.prompt(questions, answers).then(answers => {
      for (const [name, questionStorage] of Object.entries(
        storageForQuestion,
      )) {
        const answer = answers[name] === undefined ? null : answers[name];
        questionStorage.setPath(name, answer);
      }

      if (!this.options.skipCache) {
        promptSuggestion.storeAnswers(
          this._globalConfig,
          questions,
          answers,
          false,
        );
        if (!this.options.skipLocalCache) {
          promptSuggestion.storeAnswers(this.config, questions, answers, true);
        }
      }

      return answers;
    });
  }

  /**
   * Adds an option to the set of generator expected options, only used to
   * generate generator usage. By default, generators get all the cli options
   * parsed by nopt as a `this.options` hash object.
   *
   * @param {String} [name] - Option name
   * @param {Object} config - Option options
   * @param {any} config.type - Either Boolean, String or Number
   * @param {string} [config.description] - Description for the option
   * @param {any} [config.default] - Default value
   * @param {any} [config.alias] - Option name alias (example `-h` and --help`)
   * @param {any} [config.hide] - Boolean whether to hide from help
   * @param {Storage} [config.storage] - Storage to persist the option
   * @return {this} This generator
   */
  option(name, config) {
    if (Array.isArray(name)) {
      for (const option of name) {
        this.option(option);
      }

      return;
    }

    if (typeof name === 'object') {
      config = name;
      name = config.name;
    }

    config = config || {};

    // Alias default to defaults for backward compatibility.
    if ('defaults' in config) {
      config.default = config.defaults;
    }

    config.description = config.description || config.desc;

    _.defaults(config, {
      name,
      description: 'Description for ' + name,
      type: Boolean,
      hide: false,
    });

    // Check whether boolean option is invalid (starts with no-)
    const boolOptionRegex = /^no-/;
    if (config.type === Boolean && boolOptionRegex.test(name)) {
      const simpleName = name.replace(boolOptionRegex, '');
      throw new Error(
        [
          `Option name ${chalk.yellow(name)} cannot start with ${chalk.red(
            'no-',
          )}\n`,
          `Option name prefixed by ${chalk.yellow(
            '--no',
          )} are parsed as implicit`,
          ` boolean. To use ${chalk.yellow('--' + name)} as an option, use\n`,
          chalk.cyan(`  this.option('${simpleName}', {type: Boolean})`),
        ].join(''),
      );
    }

    if (this._options[name] === null || this._options[name] === undefined) {
      this._options[name] = config;
    }

    if (!this.options.skipParseOptions) {
      this.parseOptions();
    }

    if (config.storage && this.options[name] !== undefined) {
      const storage =
        typeof config.storage === 'string'
          ? this[config.storage]
          : config.storage;
      storage.set(name, this.options[name]);
    }

    return this;
  }

  /**
   * Adds an argument to the class and creates an attribute getter for it.
   *
   * Arguments are different from options in several aspects. The first one
   * is how they are parsed from the command line, arguments are retrieved
   * based on their position.
   *
   * Besides, arguments are used inside your code as a property (`this.argument`),
   * while options are all kept in a hash (`this.options`).
   *
   *
   * @param {String} name - Argument name
   * @param {Object} config - Argument options
   * @param {any} config.type - String, Number, Array, or Object
   * @param {string} [config.description] - Description for the argument
   * @param {boolean} [config.required] - required` Boolean whether it is required
   * @param {boolean} [config.optional] - Boolean whether it is optional
   * @param {any} [config.default] - Default value for this argument
   * @return {this} This generator
   */
  argument(name, config) {
    config = config || {};

    // Alias default to defaults for backward compatibility.
    if ('defaults' in config) {
      config.default = config.defaults;
    }

    config.description = config.description || config.desc;

    _.defaults(config, {
      name,
      required: config.default === null || config.default === undefined,
      type: String,
    });

    this._arguments.push(config);

    if (!this.options.skipParseOptions) {
      this.parseOptions();
    }

    return this;
  }

  parseOptions() {
    const minimistDef = {
      string: [],
      boolean: [],
      alias: {},
      default: {},
    };

    _.each(this._options, option => {
      if (option.type === Boolean) {
        minimistDef.boolean.push(option.name);
        if (!('default' in option) && !option.required) {
          minimistDef.default[option.name] = EMPTY;
        }
      } else {
        minimistDef.string.push(option.name);
      }

      if (option.alias) {
        minimistDef.alias[option.alias] = option.name;
      }

      // Only apply default values if we don't already have a value injected from
      // the runner
      if (option.name in this._initOptions) {
        minimistDef.default[option.name] = this._initOptions[option.name];
      } else if (option.alias && option.alias in this._initOptions) {
        minimistDef.default[option.name] = this._initOptions[option.alias];
      } else if ('default' in option) {
        minimistDef.default[option.name] = option.default;
      }
    });

    const parsedOptions = minimist(this._args, minimistDef);

    // Parse options to the desired type
    _.each(parsedOptions, (option, name) => {
      // Manually set value as undefined if it should be.
      if (option === EMPTY) {
        delete parsedOptions[name];
        return;
      }

      if (this._options[name] && option !== undefined) {
        parsedOptions[name] = this._options[name].type(option);
      }
    });

    // Parse positional arguments to valid options
    for (const [index, config] of this._arguments.entries()) {
      let value;
      if (index >= parsedOptions._.length) {
        if (config.name in this._initOptions) {
          value = this._initOptions[config.name];
        } else if ('default' in config) {
          value = config.default;
        } else {
          continue;
        }
      } else if (config.type === Array) {
        value = parsedOptions._.slice(index, parsedOptions._.length);
      } else {
        value = config.type(parsedOptions._[index]);
      }

      parsedOptions[config.name] = value;
    }

    // Make the parsed options available to the instance
    Object.assign(this.options, parsedOptions);
    this.args = parsedOptions._;
    this.arguments = parsedOptions._;

    // Make sure required args are all present
    this.checkRequiredArgs();
  }

  checkRequiredArgs() {
    // If the help option was provided, we don't want to check for required
    // arguments, since we're only going to print the help message anyway.
    if (this.options.help) {
      return;
    }

    // Bail early if it's not possible to have a missing required arg
    if (this.args.length > this._arguments.length) {
      return;
    }

    for (const [position, config] of this._arguments.entries()) {
      // If the help option was not provided, check whether the argument was
      // required, and whether a value was provided.
      if (config.required && position >= this.args.length) {
        throw new Error(
          `Did not provide required argument ${chalk.bold(config.name)}!`,
        );
      }
    }
  }

  /**
   * Schedule methods on a run queue.
   *
   * @param {Function|Object} method: Method to be scheduled or object with function properties.
   * @param {String} [methodName]: Name of the method (task) to be scheduled.
   * @param {String} [queueName]: Name of the queue to be scheduled on.
   * @param {Function} [reject]: Reject callback.
   */
  queueMethod(method, methodName, queueName, reject) {
    if (typeof queueName === 'function') {
      reject = queueName;
      queueName = 'default';
    } else {
      queueName = queueName || 'default';
    }

    if (!_.isFunction(method)) {
      if (typeof methodName === 'function') {
        reject = methodName;
        methodName = undefined;
      }

      this.queueTaskGroup(method, {
        queueName: methodName,
        reject,
      });
      return;
    }

    this.queueTask({
      method,
      taskName: methodName,
      queueName,
      reject,
    });
  }

  /**
   * Schedule tasks from a group on a run queue.
   *
   * @param {Object}          taskGroup: Object containing tasks.
   * @param {TaskOptions} [taskOptions]: options.
   */
  queueTaskGroup(taskGroup, taskOptions) {
    for (const task of this.extractTasksFromGroup(taskGroup, taskOptions)) {
      this.queueTask(task);
    }
  }

  /**
   * @private
   * Extract tasks from a priority.
   *
   * @param {String}  name: The method name to schedule.
   * @param {TaskOptions} [taskOptions]: options.
   */
  extractTasksFromPriority(name, taskOptions = {}) {
    const priority = this._queues[name];
    taskOptions = {
      ...priority,
      cancellable: true,
      run: false,
      ...taskOptions,
    };

    if (taskOptions.auto && priority && priority.skip) {
      return [];
    }

    const { taskPrefix = this.features.taskPrefix || '' } = taskOptions;
    const propertyName = taskPrefix ? `${taskPrefix}${name}` : name;
    const property = Object.getOwnPropertyDescriptor(
      taskOptions.taskOrigin || Object.getPrototypeOf(this),
      propertyName,
    );
    if (!property) return [];

    const item = property.value ?? property.get.call(this);

    // Name points to a function; single task
    if (typeof item === 'function') {
      return [{ ...taskOptions, taskName: name, method: item }];
    }

    if (!item || !priority) {
      return [];
    }

    return this.extractTasksFromGroup(item, taskOptions);
  }

  /**
   * @private
   * Extract tasks from group.
   *
   * @param {Object}  group: Task group.
   * @param {TaskOptions} [taskOptions]: options.
   */
  extractTasksFromGroup(group, taskOptions) {
    return Object.entries(group)
      .map(([taskName, method]) => {
        if (typeof method !== 'function' || !methodIsValid(taskName)) return;
        return {
          ...taskOptions,
          method,
          taskName,
        };
      })
      .filter(Boolean);
  }

  /**
   * @private
   * Schedule a generator's method on a run queue.
   *
   * @param {String}  name: The method name to schedule.
   * @param {TaskOptions} [taskOptions]: options.
   */
  queueOwnTask(name, taskOptions) {
    for (const task of this.extractTasksFromPriority(name, taskOptions))
      this.queueTask(task);
  }

  /**
   * @private
   * Get task names.
   *
   * @return {string[]}
   */
  getTaskNames() {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this));
    let validMethods = methods.filter(methodIsValid);
    const { taskPrefix } = this.features;

    if (taskPrefix) {
      validMethods = validMethods
        .filter(method => method.startsWith(taskPrefix))
        .map(method => method.slice(taskPrefix.length));
    } else {
      validMethods = validMethods.filter(method => method.charAt(0) !== '#');
    }

    if (this.features.tasksMatchingPriority) {
      const queueNames = Object.keys(this._queues);
      validMethods = validMethods.filter(method => queueNames.includes(method));
    }

    return validMethods;
  }

  /**
   * @private
   * Schedule every generator's methods on a run queue.
   *
   * @param {TaskOptions} [taskOptions]: options.
   */
  queueOwnTasks(taskOptions) {
    this._running = true;
    this._taskStatus = { cancelled: false, timestamp: new Date() };

    const validMethods = this.getTaskNames();
    if (validMethods.length === 0 && this._prompts.length === 0) {
      throw new Error(
        'This Generator is empty. Add at least one method for it to run.',
      );
    }

    if (this._prompts.length > 0) {
      this.queueTask({
        method: () => this.prompt(this._prompts, this.config),
        taskName: 'Prompt registered questions',
        queueName: 'prompting',
        cancellable: true,
      });

      if (validMethods.length === 0) {
        this.queueTask({
          method: () => {
            this.renderTemplate();
          },
          taskName: 'Empty generator: copy templates',
          queueName: 'writing',
          cancellable: true,
        });
      }
    }

    for (const methodName of validMethods)
      this.queueOwnTask(methodName, taskOptions);

    this.emit('queueOwnTasks');
  }

  /**
   * Schedule tasks on a run queue.
   *
   * @param {Task} task: Task to be queued.
   */
  queueTask(task) {
    const { queueName = 'default', taskName: methodName, run, once } = task;

    const { runLoop } = this.env;
    const { _taskStatus: taskStatus, options = {} } = this;
    const { namespace = '' } = options;

    debug(
      `Queueing ${namespace}#${methodName} with options %o`,
      _.omit(task, ['method']),
    );
    runLoop.add(
      queueName,
      // Run-queue's done(continue), pause
      async continueQueue => {
        await this.executeTask(task, undefined, taskStatus);
        continueQueue();
      },
      { once: once ? methodName : undefined, run },
    );
  }

  /**
   * @private
   * Execute a task.
   *
   * @param {Task} task: Task to be executed.
   * @param {string[]} args: Task arguments.
   * @param {Object} taskStatus.
   * @return Promise
   */
  async executeTask(
    task,
    args = task.args || this.args,
    taskStatus = this._taskStatus || {},
  ) {
    const {
      reject,
      queueName = 'default',
      taskName: methodName,
      method,
    } = task;
    const { namespace = '' } = this.options || {};
    const priority = Object.entries(this._queues).find(
      ([_, options]) => options.queueName === queueName,
    );
    const priorityName = priority ? priority[0] : undefined;

    debug(`Running ${namespace}#${methodName}`);
    this.emit(`method:${methodName}`);
    const taskCancelled = task.cancellable && taskStatus.cancelled;
    if (taskCancelled) {
      return;
    }

    args = typeof args === 'function' ? args(this) : args;
    this.runningState = { namespace, queueName, methodName };
    try {
      await method.apply(this, args);
      delete this.runningState;
      const eventName = `done$${namespace || 'unknownnamespace'}#${methodName}`;
      debug(`Done event ${eventName}`);
      this.env.emit(eventName, {
        namespace,
        generator: this,
        queueName,
        priorityName,
      });
    } catch (error) {
      const errorMessage = `An error occured while running ${namespace}#${methodName}`;
      if (this.log.error) {
        this.log.error(errorMessage);
      } else {
        debug(errorMessage);
      }

      if (reject) {
        debug('Rejecting task promise, queue will continue normally');
        reject(error);
        return;
      }

      try {
        this.env.emit('error', error);
      } catch (error) {
        setImmediate(() => {
          throw error;
        });
      }
    } finally {
      delete this.runningState;
    }
  }

  /**
   * Generator config Storage.
   */
  get config() {
    if (!this._config) {
      this._config = this._getStorage();
    }

    return this._config;
  }

  /**
   * Ignore cancellable tasks.
   */
  cancelCancellableTasks() {
    this._running = false;
    // Task status references is registered at each running task
    this._taskStatus.cancelled = true;
    // Create a new task status.
    delete this._taskStatus;
  }

  /**
   * Start the generator again.
   *
   * @param {Object} [options]: options.
   */
  startOver(options = {}) {
    this.cancelCancellableTasks();
    Object.assign(this.options, options);
    this.queueOwnTasks({ auto: true });
  }

  /**
   * Runs the generator, scheduling prototype methods on a run queue. Method names
   * will determine the order each method is run. Methods without special names
   * will run in the default queue.
   *
   * Any method named `constructor` and any methods prefixed by a `_` won't be scheduled.
   *
   * @return {Promise} Resolved once the process finish
   */
  run() {
    return this.env.runGenerator(this);
  }

  /**
   * Queue generator tasks.
   */
  async queueTasks() {
    const beforeQueueCallback =
      (this.features.taskPrefix && this.beforeQueue) || this._beforeQueue;
    if (beforeQueueCallback) {
      await beforeQueueCallback.call(this);
    }

    await this._queueTasks();
  }

  /**
   * @private
   */
  async _queueTasks() {
    debug(
      `Queueing generator ${this.options.namespace} with generator version ${this.yoGeneratorVersion}`,
    );
    this.queueOwnTasks({ auto: true });

    for (const generator of this._composedWith) {
      await this.env.queueGenerator(generator, false);
    }

    this._composedWith = [];
  }

  /**
   * Compose this generator with another one.
   * @param  {String|Object|Array} generator  The path to the generator module or an object (see examples)
   * @param  {Array}  [args]       Arguments passed to the Generator
   * @param  {Object}  [options]   The options passed to the Generator
   * @param  {boolean}  [immediately] Boolean whether to queue the Generator immediately
   * @return {Generator}    The composed generator
   *
   * @example <caption>Using a peerDependency generator</caption>
   * await this.composeWith('bootstrap', { sass: true });
   *
   * @example <caption>Using a direct dependency generator</caption>
   * await this.composeWith(path.resolve(__dirname, 'generator-bootstrap/app/main.js'), { sass: true });
   *
   * @example <caption>Passing a Generator class</caption>
   * await this.composeWith({ Generator: MyGenerator, path: '../generator-bootstrap/app/main.js' }, { sass: true });
   */
  async composeWith(generator, args, options, immediately = false) {
    if (typeof args === 'boolean') {
      args = [];
    } else if (!Array.isArray(args) && typeof args === 'object') {
      options = args;
      args = options.arguments || options.args || [];
    }

    options = typeof options === 'boolean' ? {} : options || {};

    let instantiatedGenerator;

    if (Array.isArray(generator)) {
      const generators = [];
      for (const each of generator) {
        generators.push(await this.composeWith(each, args, options));
      }

      return generators;
    }

    // Pass down the default options so they're correctly mirrored down the chain.
    options = {
      destinationRoot: this._destinationRoot,
      ...options,
      skipInstall: this.options.skipInstall,
      skipCache: this.options.skipCache,
      forceInstall: this.options.forceInstall,
      skipLocalCache: this.options.skipLocalCache,
    };
    const resolveGeneratorPath = async maybePath => {
      // Allows to run a local generator without namespace.
      // Resolve the generator absolute path to current generator;
      const generatorFile = isAbsolute(maybePath)
        ? maybePath
        : pathResolve(dirname(this.resolved), maybePath);
      let generatorResolvedFile;
      try {
        const status = await stat(generatorFile);
        if (status.isFile()) {
          generatorResolvedFile = generatorFile;
        }
      } catch {}

      if (!generatorResolvedFile) {
        // Resolve the generator file.
        // Use import.resolve when stable.
        generatorResolvedFile = pathToFileURL(
          createRequire(import.meta.url).resolve(generatorFile),
        ).href;
      }

      return generatorResolvedFile;
    };

    const instantiate = async (Generator, path) => {
      Generator.resolved = path;
      Generator.namespace = this.env.namespace(path);

      return this.env.instantiate(Generator, args, options);
    };

    if (typeof generator === 'string') {
      if (this.env.isNamespace(generator)) {
        instantiatedGenerator = await this.env.create(generator, args, options);
      } else {
        try {
          const resolvedGenerator = await resolveGeneratorPath(generator);

          const GeneratorImport = await import(resolvedGenerator);
          const Generator =
            typeof GeneratorImport.default === 'function'
              ? GeneratorImport.default
              : GeneratorImport;
          instantiatedGenerator = await instantiate(
            Generator,
            resolvedGenerator,
          );
        } catch {
          // Forward to the environment
          instantiatedGenerator = await this.env.create(
            generator,
            args,
            options,
          );
        }
      }
    } else {
      const { Generator } = generator;
      let { path: generatorFile } = generator;
      assert(
        Generator,
        `${chalk.red('Missing Generator property')}
When passing an object to Generator${chalk.cyan(
          '#composeWith',
        )} include the generator class to run in the ${chalk.cyan(
          'Generator',
        )} property

await this.composeWith({
  ${chalk.yellow('Generator')}: MyGenerator,
  ...\n
});`,
      );
      assert(
        typeof generatorFile === 'string',
        `${chalk.red('path property is not a string')}
When passing an object to Generator${chalk.cyan(
          '#composeWith',
        )} include the path to the generators files in the ${chalk.cyan(
          'path',
        )} property

await this.composeWith({
  ${chalk.yellow('path')}: '../my-generator',
  ...
});`,
      );
      try {
        generatorFile = await resolveGeneratorPath(generatorFile);
      } catch {}

      instantiatedGenerator = await instantiate(Generator, generatorFile);
    }

    if (!instantiatedGenerator) {
      return instantiatedGenerator;
    }

    if (this._running || immediately) {
      this.env.queueGenerator(instantiatedGenerator);
    } else {
      this._composedWith.push(instantiatedGenerator);
    }

    return instantiatedGenerator;
  }

  /**
   * Determine the root generator name (the one who's extending Generator).
   * @return {String} The name of the root generator
   */
  rootGeneratorName() {
    const { packageJson: { name = '*' } = {} } =
      readPackageUpSync({ cwd: this.resolved }) || {};
    return name;
  }

  /**
   * Determine the root generator version (the one who's extending Generator).
   * @return {String} The version of the root generator
   */
  rootGeneratorVersion() {
    const { packageJson: { version = '0.0.0' } = {} } =
      readPackageUpSync({ cwd: this.resolved }) || {};
    return version;
  }

  /**
   * Return a storage instance.
   * @param  {String} storePath  The path of the json file
   * @param  {String} [path] The name in which is stored inside the json
   * @param  {boolean|Object} [options] Treat path as an lodash path
   * @return {Storage} json storage
   */
  createStorage(storePath, path, options) {
    if (typeof path === 'object') {
      options = path;
      path = undefined;
    } else if (typeof options === 'boolean') {
      options = { lodashPath: options };
    }

    storePath = this.destinationPath(storePath);
    return new Storage(path, this.fs, storePath, options);
  }

  /**
   * Return a storage instance.
   * @param  {String} [rootName] The rootName in which is stored inside .yo-rc.json
   * @param  {object} [options] Storage options
   * @return {Storage} Generator storage
   * @private
   */
  _getStorage(rootName = this.rootGeneratorName(), options) {
    if (typeof rootName === 'object') {
      options = rootName;
      rootName = this.rootGeneratorName();
    }

    const storePath = path.join(this.destinationRoot(), '.yo-rc.json');
    return new Storage(rootName, this.fs, storePath, options);
  }

  /**
   * Setup a globalConfig storage instance.
   * @return {Storage} Global config storage
   * @private
   */
  _getGlobalStorage() {
    // When localConfigOnly === true simulate a globalConfig at local dir
    const globalStorageDir = this.options.localConfigOnly
      ? this.destinationRoot()
      : os.homedir();
    const storePath = path.join(globalStorageDir, '.yo-rc-global.json');
    const storeName = `${this.rootGeneratorName()}:${this.rootGeneratorVersion()}`;
    return new Storage(storeName, this.fs, storePath);
  }

  /**
   * Change the generator destination root directory.
   * This path is used to find storage, when using a file system helper method (like
   * `this.write` and `this.copy`)
   * @param  {String} rootPath new destination root path
   * @return {String}          destination root path
   */
  destinationRoot(rootPath) {
    if (typeof rootPath === 'string') {
      this._destinationRoot = pathResolve(rootPath);

      if (!fs.existsSync(this._destinationRoot)) {
        fs.mkdirSync(this._destinationRoot, { recursive: true });
      }

      this.emit(DESTINATION_ROOT_CHANGE_EVENT, this._destinationRoot);
      // Reset the storage
      this._config = undefined;
      // Reset packageJson
      this._packageJson = undefined;
    }

    return this._destinationRoot || this.env.cwd;
  }

  /**
   * Change the generator source root directory.
   * This path is used by multiples file system methods like (`this.read` and `this.copy`)
   * @param  {String} rootPath new source root path
   * @return {String}          source root path
   */
  sourceRoot(rootPath) {
    if (typeof rootPath === 'string') {
      this._sourceRoot = pathResolve(rootPath);
    }

    return this._sourceRoot;
  }

  /**
   * Join a path to the source root.
   * @param  {...String} dest - path parts
   * @return {String}    joined path
   */
  templatePath(...dest) {
    let filepath = path.join.apply(path, dest);

    if (!path.isAbsolute(filepath)) {
      filepath = path.join(this.sourceRoot(), filepath);
    }

    return filepath;
  }

  /**
   * Join a path to the destination root.
   * @param  {...String} dest - path parts
   * @return {String}    joined path
   */
  destinationPath(...dest) {
    let filepath = path.join.apply(path, dest);

    if (!path.isAbsolute(filepath)) {
      filepath = path.join(this.destinationRoot(), filepath);
    }

    return filepath;
  }

  /**
   * Determines the name of the application.
   *
   * First checks for name in bower.json.
   * Then checks for name in package.json.
   * Finally defaults to the name of the current directory.
   * @return {String} The name of the application
   */
  determineAppname() {
    let appname = this.fs.readJSON(this.destinationPath('bower.json'), {}).name;

    if (!appname) {
      appname = this.fs.readJSON(this.destinationPath('package.json'), {}).name;
    }

    if (!appname) {
      appname = path.basename(this.destinationRoot());
    }

    return appname.replace(/[^\w\s]+?/g, ' ');
  }

  /**
   * Add a transform stream to the commit stream.
   *
   * Most usually, these transform stream will be Gulp plugins.
   *
   * @param  {stream.Transform|stream.Transform[]} streams An array of Transform stream
   * or a single one.
   * @return {this} This generator
   */
  queueTransformStream(transformStreams) {
    assert(
      transformStreams,
      'expected to receive a transform stream as parameter',
    );

    this.queueTask({
      method() {
        return this.env.applyTransforms(transformStreams);
      },
      taskName: 'transformStream',
      queueName: 'transform',
    });
    return this;
  }
}

// eslint-disable-next-line unicorn/no-array-reduce
const Generator = [helpMixin, fsMixin, userMixin].reduce(
  (a, b) => b(a),
  BaseGenerator,
);

export default Generator;
