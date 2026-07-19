import logging
import os
import sys

import uvicorn
from dotenv import load_dotenv
from fh_saas.utils_log import configure_logging

load_dotenv()

from routes import create_app
from startup import check_existing_server


configure_logging(level=os.getenv("FH_SAAS_LOG_LEVEL", "WARNING"))
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = create_app()


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "3137"))
    try:
        existing_server = check_existing_server(host, port)
    except RuntimeError as error:
        logging.error("%s", error)
        sys.exit(1)
    if existing_server:
        print(f"Personal Note is already running at {existing_server}/notes")
        sys.exit(0)
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=os.getenv("RELOAD", "0") == "1",
    )