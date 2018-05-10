'use strict';

/**
 * Module dependenices
 */

const clone = require('@logoran/clone-deep');
const isPlainObject = require('is-plain-object');
const debug = require('debug')('object-templates');

function match(value) {
  return value.search(/\$\{.*?\}/) !== -1;
}

function getItemName(value) {
  const itemname = value.match(/[\w-]+?$/);
  if (itemname) {
    return itemname;
  }
  itemname = value.match(/\[\'[\w-]+?\'\]$/);
  return itemname.substr(2, itemname.length - 4);
}

function regSymbolEncode(value) {
  return value.replace(/([\[\'\]])/g, '\\$1');
}

function objectTemplates(template, constants = {}, options) {
  // strict mode use independent scope, can't set var
  // for (let key in constants) {
  //   eval(`var ${key} = ${constants[key]};`);
  // }

  const _arguments = options._arguments || [];
  const cloneInstances = options.cloneInstances || [];
  const alias = options.alias || [];
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
      return value;
    }
  }

  function getConstAlias() {
    let alias = [];
    for (let key in constants) {
      alias.push([key, `constants.${key}`]);
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
        statement = `return (${value});\n`;
      } else if (data instanceof Array || allowUndefined) {
        statement = `result${path} = (${value});\n`;
      } else {
        statement = 
          `if ((${value}) !== undefined) {
            result${path} = (${value});
          } else {
            delete result${path};
          };\n`;
      }
      debug('value %s get statement %s', value, statement);
      return [true, statement];
    }
  }

  function replaceObject(data, path = '', innerAlias = getConstAlias()) {
    for (let key in data) {
      let value = data[key];
      if (key.search(/\$array.*?/) !== -1 && value['__stub'] && typeof value['__stub'] === 'string'
        && value['__value']) {
        let name = key.substring(6);
        if (value['__name'] && typeof value['__name'] === 'string') {
          name = value['__name'];
        }
        const itemname = getItemName(value['__stub']);
        if (value['__value'] instanceof Array || typeof value['__value'] === 'object') {
          statement += 
            `delete result${path}['${key}'];
            {
              let items = result${path}['${name}'] = [];
              let src = ${value['__stub']};
              for (let ${itemname}_seq in src) {
                let result = this.clone(this.data${path}['${key}']['__value']);
                let ${itemname} = src[${itemname}_seq];\n`
          replaceObject(value['__value'], '', innerAlias.concat([[`${itemname}.__seq`, `${itemname}_seq`], [`${itemname}['__seq']`, `${itemname}_seq`]]));
          statement += 
                `items.push(result);
              }
            }\n`
        } else if ('string' === typeof value['__value']) {
          statement +=
            `delete result${path}['${key}'];
            {
              let items = result${path}['${name}'] = [];
              let src = ${value['__stub']};
              for (let ${itemname}_seq in src) {
                let result;\n`
          if (match(value['__value'])) {
            const [ok, _statement] = getStatement(value['__value'], '', [], innerAlias.concat([[`${itemname}.__seq`, `${itemname}_seq`], [`${itemname}['__seq']`, `${itemname}_seq`]]));
            if (ok) {
              statement += `let ${itemname} = src[${itemname}_seq];
                ${_statement}`;
            } else {
              value['__value'] = _statement;
              statement += `result = this.data${path}['${key}']['__value'];\n`;
            }
          } else {
            statement += `result = this.data${path}['${key}']['__value'];\n`;
          }
          statement += 
                `items.push(result);
              }
            }\n`
        }
      } else if (value instanceof Array || isPlainObject(value) || cloneInstances.includes(value.constructor)) {
        replaceObject(value, `${path}['${key}']`, innerAlias);
      } else if ('string' === typeof value && match(value)) {
        const [ok, _statement] = getStatement(value, `${path}['${key}']`, data, innerAlias);
        if (ok) {
          statement += _statement;
          // debug('replaceObject %o to statement %s', data, statement);
        } else {
          data[key] = _statement;
          // debug('replaceObject %o to value %o', data, _statement);
        }
      }
    }
  }

  function replaceString(str, innerAlias = getConstAlias()) {
    if (match(str)) {
      const [ok, _statement] = getStatement(value);
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
      statement = `const constants = this.constants;\n` + statement;
      debug('return function (%s) {%s}', _arguments.join(','), statement);
      return new Function(..._arguments, statement).bind({constants});
    } else {
      debug('return value %o', template);
      return function() {return template;};
    }
  } else {
    replaceObject(template);
    if ('' !== statement) {
      statement = (cloneInstances.length ? 
        'let result = this.clone(this.data, this.instanceClone);\n' :
        'let result = this.clone(this.data);\n')
        + statement
        + 'return result;';
      statement = `const constants = this.constants;\n` + statement;
      debug('return function (%s) {%s}', _arguments.join(','), statement);
      return new Function(..._arguments, statement).bind({data: template, clone, instanceClone, constants});
    } else {
      debug('return value %o', template);
      return function() {return template;};
    }
  }
}

/**
 * Expose `objectTemplates`
 */

module.exports = objectTemplates;
