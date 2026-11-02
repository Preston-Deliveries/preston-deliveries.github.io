# Contract 1161 app

The app is one page. **Edit `src/index.html`, never `index.html` directly.**

`index.html` is the slimmed copy that GitHub Pages serves. After any change to `src/index.html`:

```
cd tools && npm install && npm run build
```

Then commit both `src/index.html` and `index.html`.

- Bump `const VERSION='…'` in `src/index.html` with every change (year month day hour minute, Queensland time). The build keeps a copy of it so the update check and `sw.js` still find it.
- The build only removes style declarations that a later rule with the exact same selector replaces, and minifies styles and code. It does not change how anything looks.
