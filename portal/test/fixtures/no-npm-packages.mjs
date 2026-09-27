// Loaded with `node --import` by lab-builder-offline.test.js.
//
// Refuses to resolve any npm package, which is exactly the situation CI is in
// when it runs the lab builder CLI before `npm ci`. Node built-ins, relative
// paths, and file URLs resolve normally.

import { isBuiltin, registerHooks } from "node:module";

const LOCAL = /^(?:\.{1,2}\/|\/|file:|data:|node:|[A-Za-z]:[\\/])/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!LOCAL.test(specifier) && !isBuiltin(specifier)) {
      const error = new Error(`Blocked npm package "${specifier}": the offline lab builder must not need portal/node_modules`);
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    }
    return nextResolve(specifier, context);
  },
});
