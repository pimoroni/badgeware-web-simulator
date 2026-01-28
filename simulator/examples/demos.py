import os
app = __import__("/system/apps/demos/__init__")

def update():
    app.update()