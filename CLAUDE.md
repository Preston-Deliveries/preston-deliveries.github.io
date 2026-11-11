# Contract 1161 app

The app is one page. **Edit `src/index.html`, never `index.html` directly.**

`index.html` is the slimmed copy that GitHub Pages serves. After any change to `src/index.html`:

```
cd tools && npm install && npm run build
```

Then commit both `src/index.html` and `index.html`.

- Don't set `const VERSION='…'` by hand. `npm run build` stamps it with the real Queensland time it was built (1 + year month day hour minute) and writes it into both `src/index.html` and `index.html`. The build also keeps a copy of it so the update check and `sw.js` still find it.
- The build only removes style declarations that a later rule with the exact same selector replaces, and minifies styles and code. It does not change how anything looks.
