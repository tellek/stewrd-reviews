import sys, zipfile
name = sys.argv[1]
files = ['plugin.json', 'settings.json', 'icon.png', 'dist/index.js']
with zipfile.ZipFile(name, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f)
