# App checks

Run from the project folder:

```
pip install playwright pillow
python3 tools/test/run.py            # quick check
python3 tools/test/run.py --full     # every page, both views, phone and desktop, light and dark, all languages
python3 tools/test/run.py --compare old.html index.html --out diffs   # pixel compare two versions
```

The app runs with a fake Firebase, so no real data is read or saved. It checks for:
- script errors on every page
- pages that slide sideways or content that runs off screen
- text that is hard to read against its background
- every tab, filter, count card and date dropdown can be clicked without errors
- voice commands land on the right page
