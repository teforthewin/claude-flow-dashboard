# ── Flow-dashboard web server ────────────────────────────────────────────────
FROM python:3.13-slim

WORKDIR /app

COPY flow-dashboard/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY flow-dashboard/flow_server.py .
COPY flow-dashboard/generate_flow_diagram.py .
COPY flow-dashboard/static ./static

# Log dir is mounted at runtime; create a fallback so the server starts cleanly
RUN mkdir -p /root/.claude/flow-logs

ENV FLOW_LOG_DIR=/root/.claude/flow-logs
ENV FLOW_SERVER_PORT=7842

EXPOSE 7842

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:7842/')" || exit 1

CMD ["python3", "flow_server.py"]
