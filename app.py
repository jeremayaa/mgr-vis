import socket
import qrcode
from server import create_app


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    finally:
        s.close()
    return ip


if __name__ == "__main__":
    app = create_app()

    port = 5050
    ip = get_local_ip()
    url = f"http://{ip}:{port}/"

    print("\nOpen this URL on devices in the same network:")
    print(url)
    print("\nScan this QR code:\n")

    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr.print_ascii(invert=True)

    app.run(host="0.0.0.0", port=port, debug=False)
