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
  if (typeof value === 'string') {
    const itemname = value.match(/[\w-]+?$/);
    if (itemname) {
      return [value, itemname, 'seq'];
    }
    itemname = value.match(/\[\'[\w-]+?\'\]$/);
    return [value, itemname.substr(2, itemname.length - 4), 'seq'];
  } else {
    let stab, item, seq = 'seq';
    for (let key in value) {
      if (key !== '__seq') {
        item = key;
        stab = value[key];
      } else {
        seq = value[key];
      }
    }
    return [stab, item, seq];
  }
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
      alias.push([key, `constants.${key}`]);
    }
    for (let key in helpers) {
      alias.push([`${key}\\s*?(`, `helpers.${key}(`]);
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
      if (key.search(/\$array.*?/) !== -1 && value['__stub'] && (typeof value['__stub'] === 'string' || value['__stub'] instanceof Array)
        && value['__value']) {
        let name = key.substring(6);
        if (value['__name'] && typeof value['__name'] === 'string') {
          name = value['__name'];
        }
        const stabs = (typeof value['__stub'] === 'string') ? [value['__stub']] : value['__stub'];
        const __alias = [];
        let endsm = '';
        statement += 
          `delete result${path}['${key}'];
          {
            let items = result${path}['${name}'] = [];`;
        for (let i in stabs) {
          const stab = stabs[i];
          const [stabname, itemname, seq] = getItemName(stab);
          statement += `
            let src_${i} = ${stabname};
            for (let ${itemname}_seq in src_${i}) {
              let ${itemname} = src_${i}[${itemname}_seq];`;
          __alias.push([`${itemname}.${seq}`, `${itemname}_seq`], [`${itemname}['${seq}']`, `${itemname}_seq`]);
          endsm += '}';
        }
        if (value['__value'] instanceof Array || typeof value['__value'] === 'object') {
          statement += `
                let result = this.clone(this.data${path}['${key}']['__value']);\n`
          replaceObject(value['__value'], '', innerAlias.concat(__alias));
        } else if ('string' === typeof value['__value']) {
          if (match(value['__value'])) {
            const [ok, _statement] = getStatement(value['__value'], '', [], innerAlias.concat(__alias));
            if (ok) {
              statement += `let result;
                ${_statement}`;
            } else {
              value['__value'] = _statement;
              statement += `let result = this.data${path}['${key}']['__value'];\n`;
            }
          } else {
            statement += `let result = this.data${path}['${key}']['__value'];\n`;
          }
        }
        statement += 
              `items.push(result);
            ${endsm}
          }\n`
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
      statement = `const constants = this.constants;
        const helpers = this.helpers;\n` + statement;
      debug('return function (%s) {%s}', _arguments.join(','), statement);
      return new Function(..._arguments, statement).bind({constants, helpers});
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
      statement = `const constants = this.constants;
        const helpers = this.helpers;\n` + statement;
      debug('return function (%s) {%s}', _arguments.join(','), statement);
      return new Function(..._arguments, statement).bind({data: template, clone, instanceClone, constants, helpers});
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
