FROM node:10-slim

# ENV variables included in dockerfile for testing. In production they shoud be set when running the container and remove from the build file.
ENV ID_SCOPE '<IOTC Scope ID>'
ENV IOTC_SAS_KEY '<ITOC Primary or Secondary SAS Key>'
ENV DEVICE_ID '<IOTC Device ID>'
ENV MQTT_BROKER '<MQTT Broker address>'
ENV MQTT_SUBSCRIBE_TOPIC '<MQTT Topic>'
ENV MQTT_PUBLISH_TOPIC '<MQTT Topic>'

WORKDIR /app/

COPY package*.json ./

RUN npm install --production

COPY utils.js ./
COPY app.js ./

USER node

CMD ["node", "app.js"]