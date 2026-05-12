FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY rating_engine/ ./rating_engine/
COPY scripts/ ./scripts/
COPY models/ ./models/
COPY wsgi.py .

ENV FLASK_APP=wsgi:app
ENV PYTHONUNBUFFERED=1

EXPOSE 5000

CMD ["flask", "run", "--host", "0.0.0.0", "--port", "5000"]
