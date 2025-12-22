import os
import gc
import sys
import math
import picovector
import builtins
import simulator
import random
import io as stream


# takes a text string (that may include newline characters) and performs word
# wrapping. returns a line of lines and their widths as a result.
def wrap_and_measure(image, text, size, max_width):
    result = []
    for line in text.splitlines():
        # if max_width is specified then perform word wrapping
        if max_width:
            # setup a start and end cursor to traverse the text
            start, end = 0, 0
            last_width = 0
            i = 0
            while True:
                i += 1
                # search for the next space
                end = line.find(" ", end)
                if end == -1:
                    end = len(line)

                # measure the text up to the space
                width, _ = image.measure_text(line[start:end], size)
                if width >= max_width:
                    # line exceeded max length
                    new_end = line.rfind(" ", start, end)
                    if new_end == -1:
                        result.append((line[start:end], last_width))
                        start = end + 1
                    else:
                        result.append((line[start:new_end], last_width))
                        start = new_end + 1
                elif end == len(line):
                    # reached the end of the string
                    result.append((line[start:end], width))
                    break

                # step past the last space
                end += 1
                last_width = width
        else:
            # no wrapping needed, just return the original line with its width
            width, _ = image.measure_text(line, size)
            result.append((line, width))

    return result


def clamp(v, vmin, vmax):
    return max(vmin, min(v, vmax))


def rnd(v1, v2=None):
    if v2:
      return random.randint(v1, v2)
    else:
      return random.randint(0, v1)


def frnd(v1, v2=None):
    if v2:
      return random.uniform(v1, v2)
    else:
      return random.uniform(0, v1)


def file_exists(path):
    try:
        os.stat(path)
        return True
    except OSError:
        return False


def is_dir(path):
    try:
        flags = os.stat(path)
        return flags[0] & 0x4000  # is a directory
    except:  # noqa: E722
        return False


class SpriteSheet:
    def __init__(self, file, columns, rows):
        self.image = image.load(file)
        self.sw = int(self.image.width / columns)
        self.sh = int(self.image.height / rows)

        self.sprites = []
        for x in range(columns):
            column = []
            for y in range(rows):
                sprite = self.image.window(self.sw * x, self.sh * y, self.sw, self.sh)
                column.append(sprite)
            self.sprites.append(column)

    def sprite(self, x, y):
        return self.sprites[x][y]

    def animation(self, x=0, y=0, count=None, horizontal=True):
        if not count:
            count = int(self.image.width / self.sw)
        return AnimatedSprite(self, x, y, count, horizontal)


class AnimatedSprite:
    def __init__(self, spritesheet, x, y, count, horizontal=True):
        self.spritesheet = spritesheet
        self.frames = []
        for _ in range(count):
            self.frames.append((x, y))
            if horizontal:
                x += 1
            else:
                y += 1

    def frame(self, frame_index=0):
        frame_index = int(frame_index)
        frame_index %= len(self.frames)
        return self.spritesheet.sprite(
            self.frames[frame_index][0], self.frames[frame_index][1]
        )

    def count(self):
        return len(self.frames)


def load_font(font_file):
    try:
        return pixel_font.load(font_file)
    except OSError:
        return pixel_font.load(f"/rom/fonts/{font_file}.ppf")


class ROMFonts:
    def __getattr__(self, key):
        try:
            return pixel_font.load(f"/rom/fonts/{key}.ppf")
        except OSError:
            raise AttributeError(f"Font {key} not found!")

    def __dir__(self):
        return [f[:-4] for f in os.listdir("/rom/fonts") if f.endswith(".ppf")]


rom_font = ROMFonts()

# Import PicoSystem module constants to builtins,
# so they are available globally.
for k, v in picovector.__dict__.items():
    if not k.startswith("__"):
        setattr(builtins, k, v)


LORES = 0
HIRES = 1

def mode(mode, force=False):
    global _current_mode

    if mode == _current_mode and not force:
        return False

    _current_mode = mode

    # TODO: Mutate the existing screen object?
    font = getattr(getattr(builtins, "screen", None), "font", None)
    brush = getattr(getattr(builtins, "screen", None), "pen", None)
    antialias = getattr(getattr(builtins, "screen", None), "antialias", None)
    resolution = (320, 240) if mode == HIRES else (160, 120)
    setattr(builtins, "screen", image(*resolution, simulator.get_buffer()))
    screen.font = font if font is not None else DEFAULT_FONT
    screen.pen = brush if brush is not None else BG
    screen.antialias = antialias if antialias else image.X2
    picovector.default_target = screen

    return True


DEFAULT_FONT = rom_font.sins
ERROR_FONT = rom_font.nope

BG = color.rgb(20, 30, 40)
FG = color.rgb(255, 255, 255)

_current_mode = LORES
mode(_current_mode, True)


def get_exception(e):
    s = stream.StringIO()
    sys.print_exception(e, s)
    s.seek(0)
    # s.readline()  # Drop the "Traceback" bit
    return s.read()


# Draw an overlay box with a given message within it
def message(title, text, window=None):
    if _current_mode == LORES:
        temp = image(160, 120)
        temp.blit(screen, point(0, 0))
        mode(HIRES)
        screen.blit(temp, rect(0, 0, 320, 240))

    error_window = window or screen.window(10, 10, screen.width - 20, screen.height - 20)
    error_window.font = ERROR_FONT

    # Draw a light grey background
    background = shape.rounded_rectangle(
        0, 24, error_window.width, error_window.height - 24, 0, 0, 5, 5
    )
    heading = shape.rounded_rectangle(0, 0, error_window.width, 24, 5, 5, 0, 0)
    error_window.pen = color.rgb(78, 66, 89, 240)
    error_window.shape(background)

    error_window.pen = color.rgb(10, 20, 30, 240)
    error_window.shape(heading)

    error_window.pen = color.rgb(255, 255, 255)
    y = 4
    error_window.text(title, 5, y)
    y += 24

    error_window.pen = color.rgb(200, 200, 200)
    text_lines = wrap_and_measure(error_window, text, 12, error_window.width - 10)
    for line, _width in text_lines:
        error_window.text(line, 5, y)
        y += 15


def warning(title, text):
    print(f"- ERROR: {text}")
    try:
        message(title, text)
    except Exception as e:
        print(get_exception(e))


failed = False


def _update(update):
    global failed
    if not failed:
        screen.pen = BG
        screen.clear()
        screen.pen = FG
        io.poll()
        try:
            update()
        except Exception as e:  # noqa: BLE001
            warning("Error!", get_exception(e))
            failed = True
        gc.collect()
    simulator.update(screen.width == 320)


# Promote some commonly used Badgeware features to builtins
for k in ("mode", "LORES", "HIRES", "SpriteSheet", "load_font", "rom_font", "clamp", "rnd", "frnd", "_update"):
    setattr(builtins, k, locals()[k])

# Promote some commonly used math functions to builtins
for k in ("acos", "asin", "atan", "atan2", "ceil", "cos", "degrees", "exp", "fabs", "floor", "fmod", "log", "log", "log10", "log2", "pow", "radians", "sin", "sqrt", "tan"):
    setattr(builtins, k, getattr(math, k))

setattr(builtins, "PI", math.pi)