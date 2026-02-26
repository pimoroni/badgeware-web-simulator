class BoardPins:
    CL0 = 0
    CL1 = 1
    CL2 = 2
    CL3 = 3
    VBAT_SENSE = -1
    VBUS_DETECT = -1
    CHARGE_STAT = -1
    SENSE_1V1 = -1


class Pin:
    board = BoardPins()

    def __init__(self, value):
        self._value = value

    def value(self):
        return self._value

class ADC:
    def __init__(self, value):
        self._value = value

    def read_u16(self):
        if callable(self._value):
            return self._value()
        return self._value


class I2C():
    def __init__(self):
        return None


class RTC():
    def __init__(self):
        pass

    def datetime(self, *args):
        if len(args):
            return
        return 2026, 1, 19, 0, 12, 5, 0, 0
    

class PWM():
    def __init__(self, *args):
        pass

    def freq(self, freq):
        pass

    def duty_u16(self, duty):
        pass
