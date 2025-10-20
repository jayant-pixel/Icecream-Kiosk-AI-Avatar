FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=on

WORKDIR /app

# Install runtime deps
RUN pip install --no-cache-dir \
    "livekit-agents[anam,openai,deepgram,cartesia]~=1.2.0" \
    httpx==0.27.2

COPY scoop_agent.py /app/scoop_agent.py

CMD ["python", "-u", "scoop_agent.py"]
