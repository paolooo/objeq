/*!
 * objeq (JavaScript Object Querying)
 * Licensed under the MIT License
 * see doc/LICENSE.md
 *
 * @author Thom Bradford (github/bradford653)
 * @author Stefano Rago (github/sterago)
 */

(function () {
  var CurrentVersion = "0.1.0"
    , self = this || { $objeqParser: null };

  // Feature Checking *********************************************************

  var hasDefineProperty = Object.prototype.defineProperty
    , hasDefineSetter = Object.prototype.__defineSetter__;

  if ( !hasDefineProperty && !hasDefineSetter ) {
    throw new Error("Property Definitions not available!");
  }

  var objeqParser = null;
  if ( self.$objeqParser ) {
    objeqParser = self.$objeqParser;
  }
  else {
    if ( typeof require === 'function' ) {
      objeqParser = require('./objeq-parser').parser;
    }
    else {
      throw new Error("objeq Parser not available!");
    }
  }

  // By default, try to use standard ECMAScript defineProperty
  function defineProperty1(obj, key, getter, setter) {
    Object.defineProperty(obj, key, {
      get: getter,
      set: setter
    });
  }

  // Otherwise, well have to fall back to __defineSetter__ / __defineGetter
  function defineProperty2(obj, key, getter, setter) {
    obj.__defineGetter__(key, getter);
    if ( setter ) {
      obj.__defineSetter__(key, setter);
    }
  }

  function fallbackIsArray(obj) {
    return obj != null && toString.call(obj) === '[object Array]';
  }

  var defineProperty = hasDefineProperty ? defineProperty1 : defineProperty2
    , toString = Object.prototype.toString
    , isArray = Array.isArray || fallbackIsArray;

  // Utility Functions ********************************************************

  function makeArray(arr) {
    return Array.prototype.slice.call(arr, 0);
  }

  // we control usage, so we don't need to check for hasOwnProperty
  function mixin(obj) {
    for ( var i = 1, ilen = arguments.length; i < ilen; i++ ) {
      var hash = arguments[i];
      for ( var key in hash ) {
        obj[key] = hash[key];
      }
    }
  }

  function isDecorated(value) {
    return value.__objeq_id__ ? true : false;
  }

  function getObjectId(value) {
    return value && value.__objeq_id__ || null;
  }

  function getArrayContentKey(arr) {
    return getObjectId(arr) + '_content';
  }

  function getArrayLengthKey(arr) {
    return getObjectId(arr) + '_length';
  }

  // Extension Functions ******************************************************

  var ext = {
    // We only have one Extension by default, and that is sub-select support
    select: function _select(ctx) {
      var source = ctx.source;
      return source.query.apply(source, makeArray(arguments).slice(1));
    }
  };

  function registerExtension(name, func) {
    var hash = typeof name === 'object' ? name : {};
    if ( typeof name === 'string' && typeof func === 'function' ) {
      hash[name] = func;
    }
    for ( var key in hash ) {
      if ( !hash.hasOwnProperty(key) ) continue;

      var func = hash[key];
      if ( typeof key === 'string' && typeof func === 'function' ) {
        ext[key.toLowerCase()] = func;
      }
    }
  }

  // Listener Implementation **************************************************

  var queue = []                // The queue of pending notifications
    , pending = {}              // Reverse Lookup: Target -> queue Entry
    , listeners = {}            // Property@Target -> Callbacks
    , targets = {}              // Reverse Lookup: Target -> Property@Target
    , inNotifyListeners = false // to avoid recursion with notifyListeners
    , MaxNotifyCycles = 128;    // to avoid locking up the browser in loops

  function hasListeners(target, key) {
    return listeners['*@*']
        || listeners[key + '@*']
        || listeners[key + '@' + getObjectId(target)];
  }

  function addListener(target, key, callback) {
    var tkey = getObjectId(target) || '*'
      , entryKey = key + '@' + tkey
      , callbacks = listeners[entryKey] || ( listeners[entryKey] = [] );

    if ( callbacks.indexOf(callback) !== -1 ) {
      return;
    }

    // Add it to the callbacks and the target reverse lookup
    callbacks.push(callback);
    var targetEntry = targets[tkey] || ( targets[tkey] = [] );
    targetEntry.push(entryKey);
  }

  function removeListener(target, key, callback) {
    var tkey = getObjectId(target) || '*'
      , entryKey = key + '@' + tkey
      , callbacks = listeners[entryKey];

    if ( !callbacks ) {
      return;
    }

    var idx = callbacks.indexOf(callback);
    if ( idx === -1 ) {
      return;
    }

    // Remove it from the callbacks and the target reverse lookup
    callbacks.splice(idx, 1);
    var targetEntry = targets[tkey];
    targetEntry.splice(targetEntry.indexOf(entryKey), 1);
  }

  var EmptyArray = [];

  function getCallbacks(target, key) {
    var tkey = getObjectId(target)
      , callbacks = listeners[key + '@' + tkey] || EmptyArray
      , pCallbacks = listeners[key + '@*'] || EmptyArray
      , aCallbacks = listeners['*@*'] || EmptyArray;

    return callbacks.concat(pCallbacks, aCallbacks);
  }

  function notifyListeners() {
    inNotifyListeners = true;
    for ( var count = 0; queue.length && count < MaxNotifyCycles; count++ ) {
      var currentQueue = queue.slice(0);
      pending = {};
      queue = [];

      for ( var i = 0, ilen = currentQueue.length; i < ilen; i++ ) {
        var event = currentQueue[i]
          , target = event.target
          , key = event.key
          , callbacks = getCallbacks(target, key);

        for ( var j = 0, jlen = callbacks.length; j < jlen; j++ ) {
          callbacks[j](target, key, event.value, event.prev);
        }
      }

      refreshQueries();
    }
    inNotifyListeners = false;
    if ( count === MaxNotifyCycles ) {
      throw new Error("Too many notification cycles!");
    }
  }

  function queueEvent(target, key, value, prev) {
    if ( value === prev || !hasListeners(target, key) ) {
      return;
    }

    var tkey = getObjectId(target)
      , events = pending[tkey] || (pending[tkey] = {})
      , event = events[key];

    if ( !event ) {
      queue.push({ target: target, key: key, value: value, prev: prev });
    }
    else {
      if ( value === event.prev ) {
        // If we've reverted to the original value, remove from queue
        queue.splice(queue.indexOf(event), 1);
        delete events[key];
        return;
      }
      event.value = value;
    }
    if ( !inNotifyListeners ) {
      notifyListeners();
    }
  }

  // Object Decoration ********************************************************

  // We have to keep track of objects with IDs for dictionary lookups
  var nextObjectId = 1;

  function createAccessors(obj, state, key) {
    state[key] = obj[key];

    function setter(value) {
      value = decorate(value);

      var prev = state[key];
      if ( value === prev ) {
        return;
      }

      state[key] = value;
      queueEvent(this, key, value, prev);
    }

    function getter() {
      return state[key];
    }

    defineProperty(obj, key, getter, setter);
  }

  function decorateObject(obj) {
    var state = {};
    for ( var key in obj ) {
      if ( !obj.hasOwnProperty(key) || typeof obj[key] === 'function' ) {
        continue;
      }
      createAccessors(obj, state, key);
    }

    // Read-only Property
    var objectId = 'o' + (nextObjectId++);
    defineProperty(obj, '__objeq_id__', function () { return objectId; });

    return obj;
  }

  var ArrayFuncs = [
    { name: 'push', additive: true },
    { name: 'unshift', additive: true },
    { name: 'splice', additive: true },
    { name: 'pop', additive: false },
    { name: 'reverse', additive: false },
    { name: 'shift', additive: false },
    { name: 'sort', additive: false }
  ];

  function wrapArrayFunction(arr, name, additive) {
    var oldFunc = arr[name];
    if ( !oldFunc ) {
      throw new Error("Missing Array function: " + name);
    }

    arr[name] = function wrapped() {
      var oldLen = this.length;
      oldFunc.apply(this, arguments);
      var newLen = this.length;
      if ( additive ) {
        // TODO: This is not ideal because we only care about new items
        for ( var i = 0, ilen = this.length; i < ilen; i++ ) {
          this[i] = decorate(this[i]);
        }
      }
      // TODO: Check if the Content *really* changed
      queueEvent(this, getArrayContentKey(this), newLen, null);
      if ( newLen != oldLen ) {
        queueEvent(this, getArrayLengthKey(this), newLen, oldLen);
      }
    };
  }

  function getArrayListenerInfo(arr, name) {
    switch( name ) {
      case '.content': return { target: arr, key: getArrayContentKey(arr) };
      case '.length': return { target: arr, key: getArrayLengthKey(arr) };
      default: return { target: null, key: name };
    }
  }

  function addEventMethods(arr) {
    var callbackMapping = [];

    function wrapCallback(arr, callback) {
      // If it's already wrapped, return the wrapper
      for ( var i = 0, ilen = callbackMapping.length; i < ilen; i++ ) {
        var item = callbackMapping[i];
        if ( item.callback === callback ) {
          return item.wrapped;
        }
      }
      // Otherwise create the wrapper
      var wrapped = function _wrappedCallback(target, key, value, prev) {
        arr.indexOf(target) !== -1 && callback(target, key, value, prev);
      };
      callbackMapping.push({ callback: callback, wrapped: wrapped });
      return wrapped;
    }

    arr.on = function _on(events, callback) {
      var evt = events.split(/\s/);
      for ( var i = 0, ilen = evt.length; i < ilen; i++ ) {
        var info = getArrayListenerInfo(this, evt[i]);
        if ( !info.target ) callback = wrapCallback(this, callback);
        addListener(info.target, info.key, callback);
      }
    };

    arr.off = function _off(events, callback) {
      var evt = events.split(/\s/);
      for ( var i = 0, ilen = evt.length; i < ilen; i++ ) {
        var info = getArrayListenerInfo(this, evt[i]);
        if ( !info.target ) callback = wrapCallback(this, callback);
        removeListener(info.target, info.key, callback);
      }
    };
  }

  var DecoratedArrayMixin = {
    dynamic: dynamic, // for dynamic sub-queries
    query: query,     // for snapshot queries

    item: function _item(index, value) {
      if ( typeof value !== 'undefined' ) {
        var oldLen = this.length;
        this[index] = decorate(value);
        var newLen = this.length;
        queueEvent(this, getArrayContentKey(this), newLen, null);
        if ( newLen != oldLen ) {
          queueEvent(this, getArrayLengthKey(this), newLen, oldLen);
        }
      }
      return this[index];
    },

    attr: function _attr(key, value) {
      if ( typeof value !== 'undefined' ) {
        for ( var i = 0, ilen = this.length; i < ilen; i++ ) {
          var item = this[i];
          if ( typeof item !== 'object' ) {
            continue;
          }
          item[key] = value;
        }
      }

      var first = this[0];
      return typeof first === 'object' ? first[key] : null;
    }
  };

  function decorateArray(arr) {
    for ( var i = 0, ilen = arr.length; i < ilen; i++ ) {
      arr[i] = decorate(arr[i]);
    }

    for ( var i = 0, ilen = ArrayFuncs.length; i < ilen; i++ ) {
      var arrayFunc = ArrayFuncs[i];
      wrapArrayFunction(arr, arrayFunc.name, arrayFunc.additive);
    }

    mixin(arr, DecoratedArrayMixin);
    addEventMethods(arr);

    // Read-only Properties
    var objectId = 'a' + (nextObjectId++);
    defineProperty(arr, '__objeq_id__', function () { return objectId; });

    return arr;
  }

  function decorate(value) {
    if ( value == null || isDecorated(value) ) {
      return value;
    }

    if ( isArray(value) ) {
      return decorateArray(value);
    }
    else if ( typeof value === 'object' ) {
      return decorateObject(value);
    }

    return value;
  }

  // 'Compilation' Functions **************************************************

  function objectEvalTemplate(hash) {
    var template = {};
    for ( var key in hash ) {
      var item = hash[key], isNode = isArray(item) && item.isNode;
      template[key] = isNode ? createEvaluator(item) : item;
    }
    return template;
  }

  function arrayEvalTemplate(items) {
    var template = [];
    for ( var i = 0, ilen = items.length; i < ilen; i++ ) {
      var item = items[i], isNode = isArray(item) && item.isNode;
      template[i] = isNode ? createEvaluator(item) : item;
    }
    return template;
  }

  function evalPath(evalRoot, pathComponents) {
    var path = arrayEvalTemplate(pathComponents);
    return function _path(obj, ctx) {
      var value = evalRoot(obj, ctx);
      for ( var i = 0, ilen = path.length; i < ilen; i++ ) {
        // If we're drilling in, resolve the first Item
        if ( isArray(value) && isDecorated(value) ) {
          if ( value.length === 0 ) return null;
          value = value[0];
        }
        if ( value == null ) return value;

        var comp = path[i];
        value =  value[typeof comp === 'function' ? comp(obj, ctx) : comp];
      }
      return value;
    };
  }

  function evalArgPath(index, pathComponents) {
    var evalRoot = function _arg(obj, ctx) {
      return ctx.params[index];
    };
    return evalPath(evalRoot, pathComponents);
  }

  function evalLocalPath(pathComponents) {
    var evalRoot = function _local(obj) {
      return obj;
    };
    return evalPath(evalRoot, pathComponents);
  }

  function evalObj(template) {
    return function _obj(obj, ctx) {
      var result = {};
      for ( var key in template ) {
        var item = template[key];
        result[key] = typeof item === 'function' ? item(obj, ctx) : item;
      }
      return result;
    };
  }

  function evalArr(template) {
    return function _arr(obj, ctx) {
      var result = [];
      for ( var i = 0, ilen = template.length; i < ilen; i++ ) {
        var item = template[i];
        result[i] = typeof item === 'function' ? item(obj, ctx) : item;
      }
      return result;
    };
  }

  function evalFunc(func, template) {
    return function _func(obj, ctx) {
      var funcArgs = [];
      for ( var i = 0, ilen = template.length; i < ilen; i++ ) {
        var item = template[i];
        funcArgs[i] = typeof item === 'function' ? item(obj, ctx) : item;
      }
      return func.apply(obj, [ctx].concat(funcArgs));
    }
  }

  function evalNOT(leftEval, leftLit) {
    if ( !leftEval ) return !leftLit;
    return function _not(obj, ctx) {
      return !leftEval(obj, ctx);
    };
  }

  function evalNEG(leftEval, leftLit) {
    if ( !leftEval ) return -leftLit;
    return function _neg(obj, ctx) {
      return -leftEval(obj, ctx);
    };
  }

  function evalAND(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit && rightLit;
    return function _and(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit;
      return !lval ? lval : (rightEval ? rightEval(obj, ctx) : rightLit);
    };
  }

  function evalOR(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit || rightLit;
    return function _or(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit;
      return lval ? lval : (rightEval ? rightEval(obj, ctx) : rightLit);
    };
  }

  function evalADD(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit + rightLit;
    return function _add(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval + rval;
    };
  }

  function evalSUB(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit - rightLit;
    return function _sub(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval - rval;
    };
  }

  function evalMUL(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit * rightLit;
    return function _mul(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval * rval;
    };
  }

  function evalDIV(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit / rightLit;
    return function _div(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval / rval;
    };
  }

  function evalMOD(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit % rightLit;
    return function _mod(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval % rval;
    };
  }

  function evalEQ(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit == rightLit;
    return function _eq(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval == rval;
    };
  }

  function evalNEQ(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit != rightLit;
    return function _neq(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval != rval;
    };
  }

  function evalGT(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit > rightLit;
    return function _gt(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval > rval;
    };
  }

  function evalGTE(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit >= rightLit;
    return function _gte(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval >= rval;
    };
  }

  function evalLT(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit < rightLit;
    return function _lt(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval < rval;
    };
  }

  function evalLTE(leftEval, leftLit, rightEval, rightLit) {
    if ( !leftEval && !rightEval ) return leftLit <= rightLit;
    return function _lte(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit
        , rval = rightEval ? rightEval(obj, ctx) : rightLit;
      return lval <= rval;
    };
  }

  function evalIN(leftEval, leftLit, rightEval, rightLit) {
    var func = function _in(obj, ctx) {
      var rval = rightEval ? rightEval(obj, ctx) : rightLit;
      if ( isArray(rval) ) {
        return rval.indexOf(leftEval ? leftEval(obj, ctx) : leftLit) !== -1;
      }
      else if ( typeof rval === 'object' ) {
        return (leftEval ? leftEval(obj, ctx) : leftLit) in rval;
      }
      return false
    };
    return leftEval || rightEval ? func : func();
  }

  var regexCache = {}; // TODO: LRU Cache

  function evalRE(leftEval, leftLit, rightEval, rightLit) {
    var func = function _re(obj, ctx) {
      var lval = leftEval ? leftEval(obj, ctx) : leftLit;
      if ( typeof lval !== 'string' ) {
        return false;
      }
      var rval = rightEval ? rightEval(obj, ctx) : rightLit
        , re = regexCache[lval] || (regexCache[lval] = new RegExp(lval));
      return re.test(rval);
    };
    return leftEval || rightEval ? func : func();
  }

  function evalTern(cmpEval, cmpLit, trueEval, trueLit, falseEval, falseLit) {
    var func = function _tern(obj, ctx) {
      var cval = cmpEval ? cmpEval(obj, ctx) : cmpLit
        , tval = trueEval ? trueEval(obj, ctx) : trueLit
        , fval = falseEval ? falseEval(obj, ctx) : falseLit;
      return cval ? tval : fval;
    };
    return cmpEval || trueEval || falseEval ? func : func();
  }

  function createEvaluator(node) {
    if ( !isArray(node) || !node.isNode ) {
      return node;
    }

    // Resolving Operators
    var op = node[0];
    switch ( op ) {
      case 'path':
        var index = node[1], isNumber = typeof index === 'number';
        if ( !isNumber ) {
          return evalLocalPath(node.slice(1));
        }
        return evalArgPath(index, node.slice(2));

      case 'obj':
        return evalObj(objectEvalTemplate(node[1]));

      case 'arr':
        return evalArr(arrayEvalTemplate(node[1]));

      case 'func':
        var name = node[1], func = ext[name.toLowerCase()];
        if ( !func || typeof func !== 'function' ) {
          throw new Error("Extension '" + name + "' does not exist!");
        }
        return evalFunc(func, arrayEvalTemplate(node[2]));
    }

    // Unary Operators
    var n1 = createEvaluator(node[1]), n1Eval, n1Lit;
    typeof n1 === 'function' ? n1Eval = n1 : n1Lit = n1;

    switch ( op ) {
      case 'not': return evalNOT(n1Eval, n1Lit);
      case 'neg': return evalNEG(n1Eval, n1Lit);
    }

    // Binary Operators
    var n2 = createEvaluator(node[2]), n2Eval, n2Lit;
    typeof n2 === 'function' ? n2Eval = n2 : n2Lit = n2;

    switch ( op ) {
      case 'and': return evalAND(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'or':  return evalOR(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'add': return evalADD(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'sub': return evalSUB(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'mul': return evalMUL(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'div': return evalDIV(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'mod': return evalMOD(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'eq':  return evalEQ(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'neq': return evalNEQ(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'gt':  return evalGT(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'gte': return evalGTE(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'lt':  return evalLT(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'lte': return evalLTE(n1Eval, n1Lit, n2Eval, n2Lit);
      case 'in':  return evalIN(n1Eval, n1Lit, n2Eval, n2Lit);
      case 're':  return evalRE(n1Eval, n1Lit, n2Eval, n2Lit);
    }

    // Ternary Operator
    if ( op === 'tern' ) {
      var n3 = createEvaluator(node[3]), n3Eval, n3Lit;
      typeof n3 === 'function' ? n3Eval = n3 : n3Lit = n3;
      return evalTern(n1Eval, n1Lit, n2Eval, n2Lit, n3Eval, n3Lit);
    }

    // This should hopefully never happen
    throw new Error("Invalid parser node: " + op);
  }

  function wrapEvaluator(node) {
    var result = createEvaluator(node);
    if ( typeof result !== 'function' ) {
      return function _evalWrapper() {
        return result;
      };
    }
    return result;
  }

  function createComparator(path, ascending) {
    var getPath = evalLocalPath(path);
    if ( ascending ) {
      return function ascendingComparator(item1, item2) {
        var val1 = getPath(item1)
          , val2 = getPath(item2);
        return val1 == val2 ? 0 : val1 > val2 ? 1 : -1;
      };
    }
    else {
      return function descendingComparator(item1, item2) {
        var val1 = getPath(item1)
          , val2 = getPath(item2);
        return val1 == val2 ? 0 : val1 < val2 ? 1 : -1;
      };
    }
  }

  function createSorter(order) {
    var chain = [];
    for ( var i = 0, ilen = order.length; i < ilen; i++ ) {
      var item = order[i];
      chain.push(createComparator(item.path.slice(1), item.ascending));
    }

    return function _sorter(item1, item2) {
      for ( var i = 0, ilen = chain.length; i < ilen; i++ ) {
        var result = chain[i](item1, item2);
        if ( result !== 0 ) {
          return result;
        }
      }
      return 0;
    };
  }

  // Parsing Functions ********************************************************

  function yynode() {
    var result = makeArray(arguments);
    result.isNode = true;
    return result;
  }

  function yypath() {
    var args = makeArray(arguments)
      , result = ['path'].concat(args);
    result.isNode = true;
    this.paths.push(result);
    return result;
  }

  var parserPool = []
    , parseCache = {} // TODO: LRU Cache
    , EmptyPath = yynode('path');

  function parse(queryString) {
    var result = parseCache[queryString];
    if ( result ) {
      return result;
    }

    // Get a Parser from the pool, if possible
    var parser = parserPool.pop() || new objeqParser.Parser();
    parser.yy = { node: yynode, path: yypath, paths: [] };

    // Parse the Query, include paths and evaluators in the result
    var result = parseCache[queryString] = parser.parse(queryString);
    result.paths = parser.yy.paths;
    result.evaluate = wrapEvaluator(result.expr);
    result.select = wrapEvaluator(result.select || EmptyPath);
    result.sort = result.order && createSorter(result.order);

    // Push the Parser back onto the pool and return the result
    parserPool.push(parser);
    return result;
  }

  // Query Processing Functions ***********************************************

  // Invalidated Queries are marked and processed after notifyListeners
  var invalidated = {}
    , pendingRefresh = {};

  function invalidateQuery(results, refreshFunction) {
    var tkey = getObjectId(results);
    if ( !pendingRefresh[tkey] ) {
      invalidated[tkey] = refreshFunction;
    }
  }

  function refreshQueries() {
    pendingRefresh = invalidated;
    invalidated = {};
    for ( var key in pendingRefresh ) {
      var refreshFunction = pendingRefresh[key];
      delete pendingRefresh[key];
      refreshFunction();
    }
  }

  function addQueryListeners(paths, ctx, invalidateQuery, invalidateResults) {
    for ( var i = 0, ilen = paths.length; i < ilen; i++ ) {
      var node = paths[i]
        , index = node[1]
        , target, start, callback;

      if ( typeof index === 'number' ) {
        target = ctx.params[index]; start = 2; callback = invalidateQuery;
      }
      else {
        target = null; start = 1; callback = invalidateResults;
      }

      for ( var j = start, jlen = node.length; j < jlen; j++ ) {
        addListener(target, node[j], callback);
      }
    }
  }

  function processQuery(source, queryString, params, dynamic) {
    var root = parse(queryString)
      , results = []
      , evaluate = root.evaluate
      , select = root.select
      , sort = root.sort
      , sortFirst = root.sortFirst;

    var ctx = { };
    defineProperty(ctx, 'source', function () { return source; });
    defineProperty(ctx, 'params', function () { return params; });

    // TODO: Right now this is brute force, but we need to do deltas
    function refreshResults() {
      var prev = -results.length;
      results.length = 0;

      if ( !sort || !sortFirst || select === EmptyPath ) {
        // Post-Drilldown Sorting
        for ( var i = 0, j = 0, ilen = source.length; i < ilen; i++ ) {
          var obj = source[i];
          if ( !evaluate(obj, ctx) ) {
            continue;
          }

          results[j++] = select(obj, ctx);
        }
        if ( sort ) {
          results.sort(sort);
        }
      }
      else {
        // Pre-Drilldown Sorting
        var temp = [];
        for ( var i = 0, j = 0, ilen = source.length; i < ilen; i++ ) {
          var obj = source[i];
          if ( evaluate(obj, ctx) ) {
            temp[j++] = obj;
          }
        }
        temp.sort(sort);
        for ( var i = 0, j = 0, ilen = temp.length; i < ilen; i++ ) {
          results[j++] = select(temp[i], ctx);
        }
      }

      if ( dynamic && isDecorated(results) ) {
        queueEvent(results, getArrayContentKey(results), results.length, prev);
      }
    }

    function sourceListener(target, key, value, prev) {
      invalidateQuery(results, refreshResults); // for now
    }

    function queryListener(target, key, value, prev) {
      invalidateQuery(results, refreshResults); // for now
    }

    function resultListener(target, key, value, prev) {
      invalidateQuery(results, refreshResults); // for now
    }

    if ( dynamic ) {
      addListener(source, getArrayContentKey(source), sourceListener);
      addQueryListeners(root.paths, ctx, queryListener, resultListener);
    }
    refreshResults();

    return decorateArray(results);
  }

  function dynamic() {
    // Process a "dynamic" query whose results update with data changes
    var params = makeArray(arguments)
      , queryString = params.shift();
    // Decorate the Items, but no need to decorate the Array
    for ( var i = 0, ilen = params.length; i < ilen; i++ ) {
      params[i] = decorate(params[i]);
    }
    return processQuery(this, queryString, params, true);
  }

  function query() {
    // Process a "snapshot" query with static results
    var params = makeArray(arguments)
      , queryString = params.shift();
    return processQuery(this, queryString, params, false);
  }

  // Debug and Testing Interface **********************************************

  function debug() {
    return {
      self: self,
      objeqParser: objeqParser,
      queue: queue,
      pending: pending,
      listeners: listeners,
      targets: targets,
      nextObjectId: nextObjectId,
      invalidated: invalidated,
      pendingRefresh: pendingRefresh,
      reCache: regexCache,
      parserPool: parserPool,
      parseCache: parseCache,
      parse: parse,
      dynamic: dynamic,
      query: query
    };
  }

  // Exported Function ********************************************************

  function objeq() {
    if ( arguments.length === 1 && isArray(arguments[0]) ) {
      // Fast Path for single Array calls
      return decorate(arguments[0]);
    }
    else if ( arguments.length === 0 ) {
      // For testing and debugging only
      return debug();
    }

    var args = makeArray(arguments)
      , source = isDecorated(this) ? this : decorateArray([])
      , results = null;

    while ( args.length ) {
      var arg = args.shift();
      if ( typeof arg === 'string' ) {
        // short circuit if it's a query
        return processQuery(source, arg, args, true);
      }
      else {
        results = results || ( source = results = decorateArray([]) );
        results.push.apply(results, isArray(arg) ? arg : [arg]);
      }
    }
    return results;
  }

  defineProperty(objeq, 'VERSION', function () { return CurrentVersion; });
  objeq.registerExtension = registerExtension;

  // Node.js and CommonJS Exporting
  if ( typeof exports !== 'undefined' ) {
    if ( typeof module !== 'undefined' && module.exports ) {
      exports = module.exports = objeq;
    }
    exports.$objeq = objeq;
  }
  else {
    // Global Exporting
    self.$objeq = objeq;
  }
})();
