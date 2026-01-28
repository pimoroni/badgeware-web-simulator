import os
import gc
import sys
import math
import picovector
import builtins
import simulator
import random
import io as stream


def pen_glyph_renderer(image, parameters, _cursor, measure):
    if measure:
        return 0
    image.pen = color.rgb(*(int(c) for c in parameters))
    return None


def text_tokenise(image, text, glyph_renderers=None, size=24):
    WORD = 1
    SPACE = 2
    LINE_BREAK = 3

    default_glyph_renderers = {"pen": pen_glyph_renderer}
    default_glyph_renderers.update(glyph_renderers or {})

    tokens = []

    for line in text.splitlines():
        start, end = 0, 0
        i = 0
        while end < len(line):
            # check for a glyph_renderer
            if default_glyph_renderers and line.find("[", start) == start:
                glyph_end = line.find("]", start)
                # look ahead to see if this is an escape code
                glyph_renderer = line[start + 1:glyph_end]
                parameters = []
                if ":" in glyph_renderer:
                    code, parameters = glyph_renderer.split(":")
                    parameters = parameters.split(",")
                else:
                    code = glyph_renderer

                if code in default_glyph_renderers:
                    w = default_glyph_renderers[code](None, parameters, None, True)
                    tokens.append((default_glyph_renderers[code], w, tuple(parameters)))
                    start = glyph_end + 1
                    continue

            i += 1

            # search for the next space or glyph
            next_space = line.find(" ", start)
            next_glyph = line.find("[", start + 1)

            end = min(next_space, next_glyph)
            if end == -1:
                end = max(next_space, next_glyph)
            if end == -1:
                end = len(line)

            # measure the text up to the space
            if end > start:
                if isinstance(image.font, font):
                    width, _ = image.measure_text(line[start:end], size)
                else:
                    width, _ = image.measure_text(line[start:end])
                tokens.append((WORD, width, line[start:end]))

            start = end
            if end < len(line) and line[end] == " ":
                tokens.append((SPACE,))
                start += 1

        tokens.append((LINE_BREAK,))

    return tokens


def text_draw(image, text, bounds=None, line_spacing=1, word_spacing=1, size=24):
    WORD = 1
    SPACE = 2
    LINE_BREAK = 3

    if bounds is None:
        bounds = rect(0, 0, image.width, image.height)
    else:
        bounds = rect(int(bounds.x), int(bounds.y), int(bounds.w), int(bounds.h))

    if isinstance(text, str):
        tokens = text_tokenise(image, text, size=size)
    else:
        tokens = text

    old_clip = image.clip
    image.clip = bounds

    c = vec2(bounds.x, bounds.y)
    b = rect()
    for token in tokens:
        font_height = size if isinstance(image.font, font) else image.font.height
        if token[0] == WORD:
            if c.x + token[1] > bounds.x + bounds.w:
                c.x = bounds.x
                c.y += font_height * line_spacing
            if isinstance(image.font, font):
                image.text(token[2], c.x, c.y, size)
            else:
                image.text(token[2], c.x, c.y)
            c.x += token[1]
        elif token[0] == SPACE:
            c.x += (font_height / 3) * word_spacing
        elif token[0] == LINE_BREAK:
            c.x = bounds.x
            c.y += font_height * line_spacing
        else:
            if c.x + token[1] > bounds.x + bounds.w:
                c.x = bounds.x
                c.y += font_height * line_spacing

            token[0](image, token[2], c, False)
            c.x += token[1]

        b.w = max(b.w, c.x)
        b.h = max(b.h, c.y)

    image.clip = old_clip
    return b


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
    s.readline()  # Drop the "Traceback" bit
    return s.read()


# Draw scrolling text into a given window
def scroll_text(text, font_face=None, bg=None, fg=None, target=None, speed=25, continuous=False, font_size=None):
    font_face = font_face or rom_font.sins
    fg = fg or color.rgb(128, 128, 128)

    is_vector_font = isinstance(font_face, font)

    if is_vector_font and font_size is None:
        raise ValueError("scroll_text: vector fonts require a font_size")

    target = target or screen.window(0, 0, screen.width, screen.height)
    target.font = font_face

    tw, th = target.measure_text(text, font_size) if isinstance(font_face, font) else target.measure_text(text)

    if is_vector_font:
        th = font_size

    scroll_distance = tw + (0 if continuous else target.width)

    t_start = io.ticks

    offset = vec2(0, (target.height - th) // 2)

    def update():
        timedelta = io.ticks - t_start
        timedelta /= 1000 / speed
        progress = timedelta / scroll_distance
        timedelta %= scroll_distance
        timedelta /= scroll_distance

        if continuous:
            offset.x = -scroll_distance * timedelta
        else:
            offset.x = target.width - (scroll_distance * timedelta)

        target.font = font_face
        if bg is not None:
            target.pen = bg
            target.clear()
        target.pen = fg

        # The "font_size" argument is ignored for vector text
        target.text(text, offset, font_size)

        if continuous:
            target.text(text, offset + vec2(tw, 0), font_size)

        return progress

    return update


# Draw an overlay box with a given message within it
def message(title, msg, window=None):
    error_window = window or screen.window(5, 5, screen.width - 10, screen.height - 10)
    error_window.font = DEFAULT_FONT

    # Draw a light grey background
    background = shape.rounded_rectangle(
        0, 0, error_window.width, error_window.height, 5, 5, 5, 5
    )
    heading = shape.rounded_rectangle(0, 0, error_window.width, 12, 5, 5, 0, 0)
    error_window.pen = color.rgb(100, 100, 100, 240)
    error_window.shape(background)

    error_window.pen = color.rgb(255, 100, 100, 240)
    error_window.shape(heading)

    error_window.pen = color.rgb(50, 100, 50)
    tw = 35
    error_window.shape(
        shape.rounded_rectangle(
            error_window.width - tw - 36, error_window.height - 12, tw, 12, 3, 3, 0, 0
        )
    )

    error_window.pen = color.rgb(255, 200, 200)
    error_window.text(
        "Okay", error_window.width - tw + 5 - 36, error_window.height - 12
    )
    y = 0
    error_window.text(title, 5, y)
    y += 17

    error_window.pen = color.rgb(200, 200, 200)
    bounds = error_window.clip
    bounds.y += 12
    bounds.h -= 32
    bounds.x += 5
    bounds.w -= 10

    text_draw(error_window, msg, bounds=bounds)


def fatal_error(title, error):
    if not isinstance(error, str):
        error = get_exception(error)
    print(f"- ERROR: {error}")

    if _current_mode == LORES:
        contents = image(160, 120)
        contents.blit(screen, vec2(0, 0))
        mode(HIRES)
        screen.blit(contents, rect(0, 0, 320, 240))
        del contents

    message(title, error)

    simulator.update(screen.width == 320)


def load_font(font_file):
    search_paths = ("/rom/fonts", "/system/assets/fonts", "/fonts", "/assets", "")
    file = font_file

    # Remove /rom/fonts if searching for .af files
    if file.endswith(".af"):
        search_paths = search_paths[1:]

    extensions = (".af", ".ppf") if not file.endswith(".af") and not file.endswith(".ppf") else ("", )

    for search_path in search_paths:
        for ext in extensions:
            path = search_path + f"/{file}{ext}"
            if file_exists(path) and not is_dir(path):
                return font.load(path) if path.endswith(".af") else pixel_font.load(path)

    raise OSError(f'Font "{font_file}" not found!')


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
            fatal_error("Error!", get_exception(e))
            failed = True
        gc.collect()
    simulator.update(screen.width == 320)


# Promote some commonly used Badgeware features to builtins
for k in ("mode", "LORES", "HIRES", "SpriteSheet", "load_font", "rom_font", "text_tokenise", "text_draw", "clamp", "rnd", "frnd", "_update"):
    setattr(builtins, k, locals()[k])

# Promote some commonly used math functions to builtins
for k in ("acos", "asin", "atan", "atan2", "ceil", "cos", "degrees", "exp", "fabs", "floor", "fmod", "log", "log", "log10", "log2", "pow", "radians", "sin", "sqrt", "tan"):
    setattr(builtins, k, getattr(math, k))

setattr(builtins, "PI", math.pi)