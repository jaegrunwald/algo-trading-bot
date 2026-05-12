"""WSGI entrypoint for Docker and local `flask run`."""

from rating_engine.app import create_app

app = create_app()
