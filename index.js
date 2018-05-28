'use strict';

/**
 * Module dependenices
 */

const clone = require('@logoran/clone-deep');
const isPlainObject = require('is-plain-object');
const debug = require('debug')('object-templates');

// Argument name can't begin with '__ot_', because it maybe conflict which inner object name.
// Expansion object must have type and stub property. If a normal object has that two property, it should set isSimple = true.
// IF normal object has type stub and isSimple, the original isSimple change to '$', and other property name '$$$$' to '$''$$$$'.
// IF key name match the ${**} format, and don't want to replace, set '#' behand the key.
// IF key name match the ${**} format, and begin with '#' or '@', should add '@' behand the key.

function match(value) {
  return value.search(/\$\{.*?\}/) !== -1 && value[0] != '#';
}

function escape(value, matched) {
  if (matched) {
    return (value[0] === '#' || value[0] === '@') ? `@${value}` : value;
  }
  return `#${value}`;
}

function reverseEscape(value, matched) {
  if (matched) {
    return value[0] === '@' ? value.substr(1) : value;
  }
  return value.search(/\$\{.*?\}/) !== -1 ? value.substr(1) : value;
}

function getItemName(value) {
  if (typeof value === 'string') {
    let itemname = value.match(/[\w-]+?$/);
    if (itemname) {
      return [value, itemname, 'seq'];
    }
    itemname = value.match(/\[\'[\w-]+?\'\]$/);
    return [value, itemname.substr(2, itemname.length - 4), 'seq'];
  } else {
    return [value.name, value.item, value.seq || 'seq'];
  }
}

function getKeyName(value) {
  if (typeof value === 'string') {
    const itemname = value.match(/[\w-]+?$/);
    if (itemname) {
      return [value, itemname, 'key'];
    }
    itemname = value.match(/\[\'[\w-]+?\'\]$/);
    return [value, itemname.substr(2, itemname.length - 4), 'key'];
  } else {
    return [value.name, value.item, value.key || 'key'];
  }
}

function isExpansion(value) {
  if (value.type && value.stub) {
    if (!value.isSimple) {
      return true;
    } else {
      delete value.isSimple;
      if (value['$'] !== undefined) {
        value.isSimple = value['$'];
        delete value['$'];
      }
      const __new = {};
      for (let k in value) {
        if (k.split('$').length === k.length + 1) {
          __new[k.substr(1)] = value[k];
          delete value[k]; 
        }
      }
      Object.assign(value, __new);
    }
    return false;
  }
}

function goodExpansion(value) {
  const stub = value.stub;
  const type = value.type;
  if (type !== 'object' && type !== 'array') {
    return false;
  }
  if (typeof stub === 'string') {
    return true;
  }
  if (!(stub instanceof Array)) {
    for (let key in stub) {
      let one = stub[key].stub;
      if (typeof one === 'string') {
        continue;
      }
      if (!(one instanceof Array)) {
        return false;
      }
      for (let s of one) {
        if (typeof s !== 'string' && (!s.name || typeof s.name !== 'string' || !s.item || typeof s.item !== 'string')) {
          return false;
        }
      }
    }
    return true;
  }
  for (let s of stub) {
    if (typeof s !== 'string' && (!s.name || typeof s.name !== 'string' || !s.item || typeof s.item !== 'string')) {
      return false;
    }
  }
  return true;
}

function regSymbolEncode(value) {
  return value.replace(/([\[\'\]\(\)])/g, '\\$1');
}

function objectTemplates(template, options) {
  // the constants during all the compile and replace operating time.
  const constants = options.constants || {};
  // the argument for replace.
  const _arguments = options._arguments || [];
  // helper functions in replace.
  const helpers = options.helpers || {};
  // object type will be cloned which is not plain object.
  const cloneInstances = options.cloneInstances || [];
  // alias for replace.
  const alias = options.alias || [];
  // if allow undefined in object after replace result.
  const allowUndefined = options.allowUndefined;
  let statement = '';

  debug('_arguments = %o, cloneInstances = %o, alias = %o, allowUndefined = %o', _arguments, cloneInstances, alias, !!allowUndefined);

  function instanceClone(value) {
    const constructor = value.constructor;
    if (cloneInstances.includes(constructor)) {
      const res = new constructor();
      for (const key in value) {
        res[key] = clone(value[key], instanceClone);
      }
      return res;
    } else {
      return clone(value);
    }
  }

  function getConstAlias() {
    let alias = [];
    for (let key in constants) {
      alias.push([key, `__ot_constants.${key}`]);
    }
    for (let key in helpers) {
      alias.push([`${key}\\s*?(`, `__ot_helpers.${key}(`]);
    }
    return alias;
  }

  function getStatement(value, path = '', data = undefined, innerAlias = getConstAlias()) {
    let statement;
    // debug('getStatement %s before innerAlias %o', value, innerAlias);
    for (let [a, v] of innerAlias) {
      let r = RegExp('\\$\\{(.*?)' + regSymbolEncode(a) + '(.*?)\\}', 'g');
      value = value.replace(r, '${$1' + v + '$2}');
    }
    // debug('getStatement %s before alias', value);
    for (let [a, v] of alias) {
      let r = RegExp('\\$\\{(.*?)' + regSymbolEncode(a) + '(.*?)\\}', 'g');
      value = value.replace(r, '${$1' + v + '$2}');
    }
    // debug('getStatement %s before end replace', value);
    value = value.replace(/\$\{(.*?)\}/g, '$1');
    // debug('getStatement %s after', value);
    try {
      eval(`statement = ${value}`);
      debug('value %s get result %o', value, statement);
      return [false, statement];
    } catch (e) {
      if (data === undefined) {
        statement = `return (${value});`;
      } else if (data === false) {
        statement = value;
      } else if (data instanceof Array || allowUndefined) {
        statement = `__ot_result${path} = (${value});`;
      } else {
        statement = 
          `if ((${value}) !== undefined) {
            __ot_result${path} = (${value});
          } else {
            delete __ot_result${path};
          }`;
      }
      debug('value %s get statement %s', value, statement);
      return [true, statement];
    }
  }

  function replaceFixed(data, innerAlias, path = '') {
    if (data.value instanceof Array || isPlainObject(data.value)) {
      statement += `
        {
          const __ot_result = __ot_fixed${path}.value;`;
      replaceObject(data.value, innerAlias);
      statement += `
          __ot_items.splice(${data.index}, 0, __ot_result);
        }`;
    } else if ('string' === typeof data.value && match(data.value)) {
      const [_ok, __statement] = getStatement(data.value, '', false, innerAlias);
      if (_ok) {
        statement += `
          __ot_items.splice(${data.index}, 0, ${__statement});`;
        // debug('replaceObject %o to statement %s', data, statement);
      } else {
        data.value = __statement;
        statement += `
          __ot_items.splice(${data.index}, 0, __ot_fixed${path}.value);`;
        // debug('replaceObject %o to value %o', data, _statement);
      }
    } else {
      statement += `
        __ot_items.splice(${data.index}, 0, __ot_fixed${path}.value);`;
    }
  }

  function hasCountExpand(data) {
    if (data.count) {
      return true;
    }
    let stubs = data.stub;
    if (typeof stubs !== 'object') {
      return false;
    }
    for (let key in stubs) {
      if (stubs[key].count) {
        return true;
      }
    }
    return false;
  }

  function expandArray(data, name, innerAlias, countAlias, path = '') {
    const __alias = [];
    let endsm = '';
    const stubs = (typeof data.stub === 'string') ? [data.stub] : data.stub;
    if (path === '') {
      statement += `
          const __ot_data = __ot_temp.value;`;
    } else {
      statement += `
          __ot_data = __ot_stub['${regSymbolEncode(path)}'].value;`;
    }
    if (data.count) {
      statement += `
        __ot_count = 0;`;
    }
    for (let i in stubs) {
      const stub = stubs[i];
      const [stubname, itemname, seq] = getItemName(stub);
      statement += `
        const __ot_src_${path}${i} = ${stubname};
        for (let __ot_${itemname}_seq in __ot_src_${path}${i}) {
          let ${itemname} = __ot_src_${path}${i}[__ot_${itemname}_seq];`;
      __alias.push([`${itemname}.${seq}`, `__ot_${itemname}_seq`], [`${itemname}['${seq}']`, `__ot_${itemname}_seq`]);
      endsm += '}';
    }
    if (data.value instanceof Array || typeof data.value === 'object') {
      statement += `
            const __ot_result = this.clone(__ot_data);`
      replaceObject(data.value, innerAlias.concat(__alias));
    } else if ('string' === typeof data.value && match(data.value)) {
      const [ok, _statement] = getStatement(data.value, '', [], innerAlias.concat(__alias));
      if (ok) {
        statement += `let __ot_result;
          ${_statement}`;
      } else {
        value['value'] = _statement;
        statement += `const __ot_result = __ot_data;`;
      }
    } else {
      statement += `const __ot_result = __ot_data`;
    }
    statement += `
          __ot_items.push(__ot_result);`
    if (data.count) {
      statement += `
        __ot_count++;`;
    }
    statement += `
        ${endsm}`;
    if (data.count) {
      if (path === '') {
        statement += `
          const __ot_${name}count = __ot_count`;
        countAlias.push([`${name}.${data.count}`, `__ot_${name}count`], [`${name}['${data.count}']`, `__ot_${name}count`]);
      } else {
        statement += `
          const __ot_${path}count = __ot_count`;
        countAlias.push([`${path}.${data.count}`, `__ot_${path}count`], [`${path}['${data.count}']`, `__ot_${path}count`]);
      }
    }
  }

  function expandObject(data, name, innerAlias, countAlias, path = '') {
    const __alias = [];
    let endsm = '';
    const stubs = (typeof data.stub === 'string') ? [data.stub] : data.stub;
    for (let i in stubs) {
      const stub = stubs[i];
      const [stubname, itemname, key] = getKeyName(stub);
      statement += `
        let __ot_src_${path}${i} = ${stubname};
        for (let __ot_${itemname}_key in __ot_src_${path}${i}) {
          let ${itemname} = __ot_src_${path}${i}[__ot_${itemname}_key];`;
      __alias.push([`${itemname}.${key}`, `__ot_${itemname}_key`], [`${itemname}['${key}']`, `__ot_${itemname}_key`]);
      endsm += '}';
    }
    if ('object' !== typeof data.value || data.value instanceof Array) {
      throw 'Object expansion must expand to object';
    }
    replaceObject(data.value, innerAlias.concat(__alias));
    statement += `
        ${endsm}`;
  }

  function replaceObject(data, innerAlias = getConstAlias()) {
    const isArray = data instanceof Array;
    for (let key in data) {
      const value = data[key];
      let ok, _statement, isExpan, name, nameTag;
      if (isArray) {
        isExpan = isExpansion(value);
        name = key = Number(key);
        nameTag = name;
      } else {
        const matched = match(key);
        name = reverseEscape(key, matched);
        if (matched) {
          [ok, _statement] = getStatement(name, '', false, innerAlias);
          if (!ok) {
            name = _statement;
          }
        }
        isExpan = isExpansion(value);
        nameTag = `'${regSymbolEncode(name)}'`;
      }
      if (isExpan) {
        if (!goodExpansion(value)) {
          throw 'Expansion error';
        }
        const countAlias = [];
        const stubs = (typeof value['stub'] === 'string') ? [value['stub']] : value['stub'];
        const __alias = [];
        let endsm = '';
        if (value.type === 'array') {
          statement += `
            __ot_temp = __ot_result[${nameTag}];
            delete __ot_result[${nameTag}];
            {`;
          if (hasCountExpand(value)) {
            statement += `
              let __ot_count;`;
          }
          const stub = value.stub;
          if (typeof stub === 'object' && !(stub instanceof Array)) {
            statement += `
              const __ot_stub = __ot_temp.stub
              let __ot_data;`;
          }
          if (value.append) {
            statement += `
              const __ot_append = __ot_temp.append;`;
          }
          if (value.fixed) {
            statement += `
              const __ot_fixed = __ot_temp.fixed;`;
          }
          if (ok) {
            statement += `
              let __ot_items = __ot_result[${_statement}] = [];`;
          } else {
            statement += `
              let __ot_items = __ot_result[${nameTag}] = [];`;
          }
          if (typeof stub === 'object' && !(stub instanceof Array)) {
            for (let key in stub) {
              expandArray(stub[key], name, innerAlias, countAlias, key);
            }
          } else {
            expandArray(value, name, innerAlias, countAlias, '');
          }
          if (value.append) {
            if (value.append instanceof Array) {
              statement += `
                {
                  const __ot_result = __ot_append;`;
              replaceObject(value.append, innerAlias.concat(countAlias));
              statement += `
                  __ot_items.push(...__ot_result);
                }`;
            } else if (isPlainObject(value.append)) {
              statement += `
                {
                  const __ot_result = __ot_append;`;
              replaceObject(value.append, innerAlias.concat(countAlias));
              statement += `
                  __ot_items.push(__ot_result);
                }`;
            } else if ('string' === typeof value.append && match(value.append)) {
              const [_ok, __statement] = getStatement(value.append, '', false, innerAlias.concat(countAlias));
              if (_ok) {
                statement += `
                  __ot_items.push(${__statement});`;
                // debug('replaceObject %o to statement %s', data, statement);
              } else {
                value.append = __statement;
                statement += `
                  __ot_items.push(__ot_append);`;
                // debug('replaceObject %o to value %o', data, _statement);
              }
            } else {
              statement += `
                __ot_items.push(__ot_append);`;
            }
          }
          if (value.fixed) {
            if (value.fixed instanceof Array) {
              for (let i in value.fixed) {
                replaceFixed(value.fixed[i], innerAlias.concat(countAlias), `[${i}]`);
              }
            } else {
              replaceFixed(value.fixed, innerAlias.concat(countAlias));
            }
          }
          statement += `
            }`;
        } else {
          if (value.append) {
            statement += `
              __ot_temp = __ot_result[${nameTag}];
              delete __ot_result[${nameTag}];
              {
                const __ot_result = {};
                const __ot_append = __ot_temp.append;`;
          } else {
            statement += `
              delete __ot_result[${nameTag}];
              {
                const __ot_result = {};`
          }
          const stub = value.stub;
          if (typeof stub === 'object' && !(stub instanceof Array)) {
            for (let key in stub) {
              expandObject(stub[key], name, innerAlias, countAlias, key);
            }
          } else {
            expandObject(value, name, innerAlias, countAlias, '');
          }
          if (value.append) {
            if ('object' !== typeof value.append || value.append instanceof Array) {
              throw 'Object expansion must expand to object';
            }
            statement += `
              Object.assign(__ot_result, __ot_append);`;
            replaceObject(value.append, innerAlias);
          }
          statement += `
              __ot_temp = __ot_result;
            }`;
          if (ok) {
            statement += `
            __ot_result[${_statement}] = __ot_temp;`;
          } else {
            statement += `
            __ot_result[${nameTag}] = __ot_temp;`;
          }
        }
      } else if (value instanceof Array || isPlainObject(value) || cloneInstances.includes(value.constructor)) {
        if (ok) {
          statement += `
            __ot_temp = __ot_result[${nameTag}];
            delete __ot_result[${nameTag}];
            __ot_result[${_statement}] = __ot_temp;
            {
              const __ot_result = __ot_temp;`;
        } else {
          statement += `
            __ot_temp = __ot_result[${nameTag}];
            {
              const __ot_result = __ot_temp;`;
        }
        replaceObject(value, innerAlias);
        statement += '}';
      } else if ('string' === typeof value && match(value)) {
        if (ok) {
          const [_ok, __statement] = getStatement(value, '', false, innerAlias);
          if (_ok) {
            statement += `
              delete __ot_result[${nameTag}];
              __ot_result[${_statement}] = (${__statement});`;
            // debug('replaceObject %o to statement %s', data, statement);
          } else {
            data[key] = __statement;
            statement += `
              __ot_temp = __ot_result[${nameTag}];
              delete __ot_result[${nameTag}];
              __ot_result[${_statement}] = __ot_temp;`;
            // debug('replaceObject %o to value %o', data, _statement);
          }
        } else {
          const [_ok, __statement] = getStatement(value, `[${nameTag}]`, data, innerAlias);
          if (_ok) {
            statement += __statement;
            // debug('replaceObject %o to statement %s', data, statement);
          } else {
            data[key] = __statement;
            // debug('replaceObject %o to value %o', data, _statement);
          }
        }
      } else if (ok) {
        statement += `
          __ot_temp = __ot_result[${nameTag}];
          delete __ot_result[${nameTag}];
          __ot_result[${_statement}] = __ot_temp;`;
      }
      if (name !== key) {
        data[name] = data[key];
        delete data[key];
      }
    }
  }

  function replaceString(str, innerAlias = getConstAlias()) {
    if (match(str)) {
      const [ok, _statement] = getStatement(value, '', undefined, innerAlias);
      if (ok) {
        statement = _statement;
        // debug('replaceString %s to statement %s', str, _statement);
      } else {
        // debug('replaceString %s to value %o', str, _statement);
        return _statement;
      }
    }
  }

  if ('string' === typeof template) {
    if (!match(template)) {
      debug('return common value %s', template);
      return function() {return template;};
    }
    template += replaceString(template);
    if ('' !== statement) {
      statement = `
        const __ot_constants = this.constants;
        const __ot_helpers = this.helpers;${statement}`;
      debug('return function (%s) {%s}', _arguments.join(','), statement);
      return new Function(..._arguments, statement).bind({constants, helpers});
    } else {
      debug('return value %o', template);
      return function() {return template;};
    }
  } else {
    replaceObject(template);
    if ('' !== statement) {
      statement = `
        const __ot_constants = this.constants;
        const __ot_helpers = this.helpers;` 
        + (cloneInstances.length ? 
        'const __ot_result = this.clone(this.data, this.instanceClone);\n' :
        'const __ot_result = this.clone(this.data);\n')
        + `let __ot_temp;
        ${statement}
        return __ot_result;`;
      debug('return function (%s) {%s}', _arguments.join(','), statement);
      return new Function(..._arguments, statement).bind({data: template, clone, instanceClone, constants, helpers});
    } else {
      debug('return value %o', template);
      return function() {return template;};
    }
  }
}

objectTemplates.escape = escape;

/**
 * Expose `objectTemplates`
 */

module.exports = objectTemplates;
