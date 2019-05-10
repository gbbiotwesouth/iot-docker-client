FROM node:10-slim

# ENV variables included in dockerfile for testing. In production they shoud be set when running the container and remove from the build file.
ENV ID_SCOPE '<Your IOTC ScopeID>'
ENV IOTC_SAS_KEY '<Your IOTC Primary or Secondary Key>'
ENV DEVICE_ID '<Your device ID in IOTC>'
ENV MQTT_BROKER '<your broker URI, f.i.: 127.0.0.1>'
ENV MQTT_TOPIC '<your MQTT topic>'

WORKDIR /app/

COPY package*.json ./

RUN npm install --production

COPY app.js ./

USER node

CMD ["node", "app.js"]