import os
import math

print(os.listdir("/"))


def blackout(img):
    w = img.width
    h = img.height
    img = memoryview(img.raw)
    for i in range(0, w * h * 4, 4):
        img[i] = 0
        img[i + 1] = 0
        img[i + 2] = 0
        img[i + 3] //= 2



def update():
    screen.pen = color.white
    screen.clear()
    skull = image.load("/system/assets/skull.png")
    skull.onebit()

    skull_shadow = image(skull.width + 10, skull.height + 10)
    skull_shadow.blit(skull, vec2(5, 5))
    #skull_shadow.onebit()
    blackout(skull_shadow)
    skull_shadow.blur(1)

    y = math.sin(badge.ticks / 500) * 3

    screen.blit(skull, vec2(screen.width // 2 - (skull.width // 2), screen.height // 2 - skull.height + y))
    screen.blit(skull_shadow, skull_shadow.clip, rect(screen.width // 2 - (skull_shadow.width // 2), screen.height // 2 - y, skull_shadow.width, -20))
    """
    try:
        print(open("/test.py").read())
    except OSError:
        pass

    screen.load_into("/system/assets/squirrel-sprites/background.png")
    print(open("/test1.py").read())
    """
