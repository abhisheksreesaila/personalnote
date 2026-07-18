import logging
import os

import uvicorn
from fh_saas.utils_log import configure_logging

from routes import create_app


configure_logging(level=os.getenv("FH_SAAS_LOG_LEVEL", "WARNING"))
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = create_app()


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "3137")),
        reload=os.getenv("RELOAD", "0") == "1",
    )