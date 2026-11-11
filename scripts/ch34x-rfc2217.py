#!/usr/bin/env python3
"""Serve a WCH CH34x USB-UART bridge as an RFC 2217 port, driven from user
space over libusb, for Macs where no kernel driver claims the chip.

macOS's built-in AppleUSBCHCOM only matches the CH340 (1a86:7523) and CH9102
(1a86:55d4). A CH340K (1a86:7522), as on Elecrow's CrowPanel boards, gets no
/dev/cu.* node until WCH's DriverKit extension is approved, and that approval
cannot always be given. esptool and gea accept an rfc2217:// port, so this
bridge stands in for the missing driver:

    python3 scripts/ch34x-rfc2217.py                 # serves rfc2217://localhost:2217
    gea flash --board <alias> --app <app> --port rfc2217://localhost:2217

The register protocol follows Linux's drivers/usb/serial/ch341.c. Needs
pyusb and pyserial, and libusb (brew install libusb).
"""

import argparse
import logging
import socket
import sys
import threading

import serial
import serial.rfc2217
import usb.core
import usb.util

VENDOR = 0x1A86
PRODUCTS = (0x7522, 0x7523, 0x5523)

REQ_READ_VERSION = 0x5F
REQ_WRITE_REG = 0x9A
REQ_SERIAL_INIT = 0xA1
REQ_MODEM_CTRL = 0xA4

REG_DIVISOR_PRESCALER = 0x1312
REG_LCR2_LCR = 0x2518
LCR_ENABLE_RX = 0x80
LCR_ENABLE_TX = 0x40
LCR_STOP_BITS_2 = 0x04
LCR_PAR_EVEN = 0x10
LCR_ENABLE_PAR = 0x08
LCR_CS = {5: 0x00, 6: 0x01, 7: 0x02, 8: 0x03}
MCR_DTR = 0x20
MCR_RTS = 0x40

CLKRATE = 48_000_000
EP_OUT = 0x02
EP_IN = 0x82
PACKET_SIZE = 32


def clk_div(ps, fact):
    return 1 << (12 - 3 * ps - fact)


def divisor(speed):
    speed = max(47, min(2_000_000, speed))
    min_rates = [CLKRATE // (clk_div(ps, 1) * 512) for ps in range(4)]
    ps = 3
    while ps >= 0 and speed <= min_rates[ps]:
        ps -= 1
    if ps < 0:
        raise ValueError(f"unsupported baud rate {speed}")
    fact = 1
    cdiv = clk_div(ps, fact)
    div = CLKRATE // (cdiv * speed)
    if div < 9 or div > 255:
        div //= 2
        cdiv *= 2
        fact = 0
    if div < 2:
        raise ValueError(f"unsupported baud rate {speed}")
    if 16 * CLKRATE // (cdiv * div) - 16 * speed >= 16 * speed - 16 * CLKRATE // (cdiv * (div + 1)):
        div += 1
    if fact == 1 and div % 2 == 0:
        div //= 2
        fact = 0
    return (0x100 - div) << 8 | fact << 2 | ps


class Ch34xPort:
    """The subset of pyserial's Serial that rfc2217.PortManager drives."""

    def __init__(self, device):
        self.dev = device
        self.lock = threading.Lock()
        try:
            if self.dev.is_kernel_driver_active(0):
                self.dev.detach_kernel_driver(0)
        except (NotImplementedError, usb.core.USBError):
            pass
        self.dev.set_configuration()
        usb.util.claim_interface(self.dev, 0)
        self.version = self.dev.ctrl_transfer(0xC0, REQ_READ_VERSION, 0, 0, 2)[0]
        self._out(REQ_SERIAL_INIT, 0, 0)
        self._baudrate = 115200
        self._bytesize = 8
        self._parity = serial.PARITY_NONE
        self._stopbits = serial.STOPBITS_ONE
        self._dtr = False
        self._rts = False
        self.xonxoff = False
        self.rtscts = False
        self.break_condition = False
        self._modem_timer = None
        self._apply_line()
        self._apply_modem()

    def _out(self, request, value, index):
        with self.lock:
            self.dev.ctrl_transfer(0x40, request, value, index)

    def _apply_line(self):
        lcr = LCR_ENABLE_RX | LCR_ENABLE_TX | LCR_CS[self._bytesize]
        if self._parity != serial.PARITY_NONE:
            lcr |= LCR_ENABLE_PAR
            if self._parity == serial.PARITY_EVEN:
                lcr |= LCR_PAR_EVEN
        if self._stopbits == serial.STOPBITS_TWO:
            lcr |= LCR_STOP_BITS_2
        # Bit 7 stops the chip holding data back until a full 32-byte packet.
        self._out(REQ_WRITE_REG, REG_DIVISOR_PRESCALER, divisor(self._baudrate) | 0x80)
        if self.version >= 0x30:
            self._out(REQ_WRITE_REG, REG_LCR2_LCR, lcr)

    def _apply_modem(self):
        mcr = (MCR_DTR if self._dtr else 0) | (MCR_RTS if self._rts else 0)
        self._out(REQ_MODEM_CTRL, ~mcr & 0xFF, 0)

    def _line_property(name, apply):
        def get(self):
            return getattr(self, name)

        def set_(self, value):
            setattr(self, name, value)
            apply(self)

        return property(get, set_)

    baudrate = _line_property("_baudrate", _apply_line)
    bytesize = _line_property("_bytesize", _apply_line)
    parity = _line_property("_parity", _apply_line)
    stopbits = _line_property("_stopbits", _apply_line)
    # The RFC 2217 client sends DTR and RTS as separate commands ~50 ms apart
    # (it waits for each acknowledgement), where a native driver sets both
    # with one TIOCMSET. On the usual two-transistor auto-reset circuit the
    # in-between state of esptool's reset (DTR and RTS both active) releases
    # EN with IO0 high, and the chip boots normally instead of entering the
    # bootloader. So line changes settle for a moment and go out together in
    # one modem-control write; esptool's own pauses (100 ms holding EN low,
    # 50 ms holding IO0 low) arrive as gaps longer than the window.
    MODEM_SETTLE_S = 0.075

    def _schedule_modem(self):
        with self.lock:
            if self._modem_timer:
                self._modem_timer.cancel()
            self._modem_timer = threading.Timer(self.MODEM_SETTLE_S, self._apply_modem)
            self._modem_timer.daemon = True
            self._modem_timer.start()

    dtr = _line_property("_dtr", _schedule_modem)
    rts = _line_property("_rts", _schedule_modem)

    # Modem inputs are not wired on these boards; report them idle rather
    # than poll the chip for every RFC 2217 notification check.
    cts = dsr = ri = cd = False

    def read(self, timeout_ms=50):
        # One max-size packet per transfer: a longer request only completes on
        # a short packet, and pyusb drops the bytes of a transfer that times
        # out, which silently ate full 32-byte packets.
        try:
            return bytes(self.dev.read(EP_IN, PACKET_SIZE, timeout_ms))
        except usb.core.USBTimeoutError:
            return b""

    def write(self, data):
        with self.lock:
            self.dev.write(EP_OUT, data, 2000)

    def reset_input_buffer(self):
        while self.read(5):
            pass

    def reset_output_buffer(self):
        pass


class Connection:
    """PortManager writes its telnet negotiation through .write()."""

    def __init__(self, sock):
        self.sock = sock

    def write(self, data):
        self.sock.sendall(data)


def serve(port, client, logger=None):
    manager = serial.rfc2217.PortManager(port, Connection(client), logger=logger)
    alive = threading.Event()
    alive.set()

    def usb_to_socket():
        while alive.is_set():
            try:
                data = port.read()
            except usb.core.USBError as error:
                print(f"usb read failed: {error}", file=sys.stderr)
                alive.clear()
                break
            if data:
                if logger:
                    logger.debug("rx %r", data)
                try:
                    client.sendall(b"".join(manager.escape(data)))
                except OSError:
                    alive.clear()

    reader = threading.Thread(target=usb_to_socket, daemon=True)
    reader.start()
    try:
        while alive.is_set():
            data = client.recv(4096)
            if not data:
                break
            payload = b"".join(manager.filter(data))
            if payload:
                port.write(payload)
    except OSError:
        pass
    finally:
        alive.clear()
        reader.join()
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--tcp-port", type=int, default=2217)
    parser.add_argument("-v", "--verbose", action="store_true", help="log RFC 2217 line changes")
    args = parser.parse_args()
    logger = None
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG, format="%(relativeCreated)8.0f %(message)s")
        logger = logging.getLogger("rfc2217")

    device = None
    for product in PRODUCTS:
        device = usb.core.find(idVendor=VENDOR, idProduct=product)
        if device:
            break
    if device is None:
        sys.exit("no CH34x device on USB")
    port = Ch34xPort(device)
    print(f"CH34x {device.idVendor:04x}:{device.idProduct:04x} version 0x{port.version:02x} "
          f"on rfc2217://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.tcp_port}", flush=True)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.tcp_port))
    server.listen(1)
    while True:
        client, _ = server.accept()
        # A client that connects and drops at once (a port probe) leaves a dead
        # socket; macOS then fails setsockopt with EINVAL. Drop that client and
        # keep serving instead of taking the bridge down for everyone.
        try:
            client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            client.close()
            continue
        serve(port, client, logger)


if __name__ == "__main__":
    main()
