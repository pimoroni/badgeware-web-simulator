import os

print(os.listdir("/"))

def update():
    try:
        print(open("/test.py").read())
    except OSError:
        pass

    screen.load_into("/system/assets/squirrel-sprites/background.png")
    print(open("/test1.py").read())
