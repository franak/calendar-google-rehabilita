from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import urlopen
import os
import ssl
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def build_ssl_context(allow_insecure=False):
    """
    Construye un contexto SSL para urlopen.

    En macOS puede fallar la verificación (CERTIFICATE_VERIFY_FAILED) si el
    almacén de CA de Python no está bien instalado. Intentamos:
    1) certifi (recomendado)
    2) contexto por defecto del sistema
    3) opcional: contexto sin verificación (solo desarrollo)
    """
    if not allow_insecure:
        try:
            import certifi  # type: ignore

            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            pass

        try:
            return ssl.create_default_context()
        except Exception:
            pass

        return None

    # Desarrollo/local: desactiva verificación SSL (no recomendado en producción).
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
# ICS_SOURCE_URL = os.environ.get("ICS_SOURCE_URL", "").strip()
ICS_SOURCE_URL = "https://calendar.google.com/calendar/ical/179a497285bff3a1e40cf1c18b60b7680ef3668c57ab50692387f957a1c9f7f6%40group.calendar.google.com/public/basic.ics"


class IcsProxyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/calendar.ics":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        try:
            ctx = build_ssl_context()
            if ctx is None:
                raise RuntimeError(
                    "No se ha podido crear un contexto SSL válido. "
                    "Instala certifi (pip3 install certifi) o repara los certificados de Python."
                )

            try:
                with urlopen(ICS_SOURCE_URL, context=ctx) as resp:
                    data = resp.read()
            except ssl.SSLCertVerificationError:
                # Intento de segunda oportunidad con certifi si el primer contexto falló.
                retry_ctx = build_ssl_context(allow_insecure=False)
                if retry_ctx is not None and retry_ctx is not ctx:
                    with urlopen(ICS_SOURCE_URL, context=retry_ctx) as resp:
                        data = resp.read()
                elif os.environ.get("DISABLE_SSL_VERIFY", "").lower() in ["1", "true", "yes"]:
                    # Solo uso local/desarrollo si realmente se solicita.
                    insecure_ctx = build_ssl_context(allow_insecure=True)
                    with urlopen(ICS_SOURCE_URL, context=insecure_ctx) as resp:
                        data = resp.read()
                else:
                    raise
            except Exception:
                raise

            self.send_response(200)
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            msg = f"Error al obtener el ICS: {e}".encode("utf-8", errors="ignore")
            self.wfile.write(msg)


def run(server_class=HTTPServer, handler_class=IcsProxyHandler):
    server_address = ("0.0.0.0", 8001)
    httpd = server_class(server_address, handler_class)
    print("Proxy ICS escuchando en http://localhost:8001/calendar.ics")
    httpd.serve_forever()


if __name__ == "__main__":
    if not ICS_SOURCE_URL:
        raise SystemExit(
            "Falta ICS_SOURCE_URL. Crea un .env junto a ics_proxy.py con:\n"
            'ICS_SOURCE_URL="https://calendar.google.com/calendar/ical/.../basic.ics"\n'
        )
    run()

