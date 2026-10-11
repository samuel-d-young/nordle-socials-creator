# CLI plug-ins

Every `*.mjs` file here default-exports one command (or an array):

```js
export default { name: 'calendar', usage: 'calendar <project> [...]', summary: 'plan and build the month', async run(args) { /* return an exit code */ } };
```

`nordle.mjs` loads them all at start. Use `process.stdout`/`console.log` for output; return 0 or an exit code.
