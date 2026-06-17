import os
app = __import__("/system/apps/demos/__init__")
import time

while True:
    app.update()
    badge.update()
