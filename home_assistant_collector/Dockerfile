FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH

RUN apk add --no-cache python3 py3-pip \
    && python3 -m venv /opt/soter \
    && /opt/soter/bin/pip install --no-cache-dir --upgrade pip

COPY requirements.txt /tmp/requirements.txt
RUN /opt/soter/bin/pip install --no-cache-dir -r /tmp/requirements.txt

COPY collector.py /app/collector.py
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

LABEL \
  io.hass.name="Soter Activity Collector" \
  io.hass.description="Outbound Home Assistant sensor collector for Soter normality analysis" \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

CMD ["/run.sh"]
