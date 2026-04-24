FROM python:3.13-slim

WORKDIR /app

COPY flow-dashboard/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY flow-dashboard/flow_server.py .
COPY flow-dashboard/flow_logger.py .
COPY flow-dashboard/generate_flow_diagram.py .

RUN mkdir -p /root/.claude/flow-logs

ENV FLOW_LOG_DIR=/root/.claude/flow-logs
ENV FLOW_SERVER_PORT=7842

EXPOSE 7842

CMD ["python3", "flow_server.py"]
