// Owned test process only. Never imported by the service without an explicit
// NODE_OPTIONS preload. No target or browser network requests are introduced.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const controlFile = process.env.OWNED_HEALTH_CONTROL_FILE;
if (!controlFile) throw new Error('Owned health control file is required');
const state = {
  healthRequests: 0,
  contextRequests: 0,
  contextsCreated: 0,
  contextsOpen: 0,
  maxContextsOpen: 0,
  pageRequests: 0,
  pagesCreated: 0,
  pagesClosed: 0,
  contextsClosed: 0,
  closeCalls: 0,
};
const control = () => JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const record = (event) =>
  process.stdout.write(
    'OWNED_HEALTH ' + JSON.stringify({ event, ...state }) + '\n',
  );
const wait = async (field) => {
  while (control()[field])
    await new Promise((resolve) => setTimeout(resolve, 10));
};
const serverEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && args[0].url === '/health') {
    state.healthRequests++;
    record('health-request');
  }
  return serverEmit.call(this, event, ...args);
};
const modulePath = path.join(process.cwd(), 'dist/helpers/browser.js');
const browserModule = require(modulePath);
const launch = browserModule.launchBrowser;
browserModule.launchBrowser = async (...args) => {
  const browser = await launch(...args);
  const allocate = browser.newContext.bind(browser);
  browser.newContext = async (...options) => {
    state.contextRequests++;
    record('context-request');
    await wait('holdCreate');
    const context = await allocate(...options);
    state.contextsCreated++;
    state.contextsOpen++;
    state.maxContextsOpen = Math.max(state.maxContextsOpen, state.contextsOpen);
    record('context-created');
    context.once('close', () => {
      state.contextsOpen--;
      state.contextsClosed++;
      record('context-closed');
    });
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageOptions) => {
      state.pageRequests++;
      record('page-request');
      await wait('holdPage');
      const page = await newPage(...pageOptions);
      state.pagesCreated++;
      record('page-created');
      page.once('close', () => {
        state.pagesClosed++;
        record('page-closed');
      });
      return page;
    };
    const close = context.close.bind(context);
    context.close = async (...closeOptions) => {
      state.closeCalls++;
      record('close-request');
      await wait('holdClose');
      const value = await close(...closeOptions);
      if (control().stallCloseAck) return new Promise(() => {});
      return value;
    };
    return context;
  };
  return browser;
};
