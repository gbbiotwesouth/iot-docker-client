// IoT Central Client Module 
'use strict';

const DeviceTransport = require('azure-iot-device-mqtt');
const Device = require('azure-iot-device');
const Message = require('azure-iot-device').Message;
const mqtt = require("mqtt");
const utils = require("./utils");

const environment = {
  idScope: process.env.ID_SCOPE,
  primaryKey: process.env.IOTC_SAS_KEY,
  deviceId: process.env.DEVICE_ID,
  mqttBroker: process.env.MQTT_BROKER,
  mqttTopic: process.env.MQTT_TOPIC
};

var mqttClient;
var iotcClient;

// Send device properties
function sendDeviceProperties(twin) {
    var properties = {
      running_hours: Math.round((runningSeconds/3600)*1000)/1000
    };
    twin.properties.reported.update(properties, (errorMessage) => 
    console.log(` * Sent device properties ` + (errorMessage ? `Error: ${errorMessage.toString()}` : `(success)`)));
}

// Add any settings your device supports
// mapped to a function that is called when the setting is changed.
var settings = {
    'pump_on_off': (newValue, callback) => {
      callback(newValue, 'pending');
    }
  };

// Handle settings changes that come from Azure IoT Central via the device twin.
function handleSettings(twin) {
  twin.on('properties.desired', function (desiredChange) {
    for (let setting in desiredChange) {
      if (settings[setting]) {
        console.log(`Received setting: ${setting}: ${desiredChange[setting].value}`);
        settings[setting](desiredChange[setting].value, (newValue, status, message) => {
          var patch = {
            [setting]: {
              value: newValue,
              status: status,
              desiredVersion: desiredChange.$version,
              message: message
            }
          }
          twin.properties.reported.update(patch, (err) => console.log(`Sent setting update for ${setting}; ` +
            (err ? `error: ${err.toString()}` : `status: success`)));
        });
      }
    }
  });
}

// Respond to the echo command
function onCommandEcho(request, response) {
  // Display console info
  console.log(' * Echo command received');
  // Respond
  response.send(10, 'Success', function (errorMessage) {});
}

// Handle device connection to Azure IoT Central.
var connectCallback = (err) => {
  if (err) {
    console.log(`Device could not connect to Azure IoT Central: ${err.toString()}`);
  } else {
    console.log('Device successfully connected to Azure IoT Central');

    // Send telemetry measurements to Azure IoT Central every 1 second.
    // setInterval(sendTelemetry, 30000);

    // Setup device command callbacks
    iotcClient.onDeviceMethod('echo', onCommandEcho);

    var clientTwin;
    // Get device twin from Azure IoT Central.
    iotcClient.getTwin((err, twin) => {
      if (err) {
        console.log(`Error getting device twin: ${err.toString()}`);
      } else {
        clientTwin = twin;
        // Apply device settings and handle changes to device settings.
        handleSettings(twin);
      }
    });

    // Start listening to the MQTT communication
    mqttClient = mqtt.connect('mqtt://' + environment.mqttBroker);
    mqttClient.on('connect', () => {
      // Inform controllers that mqtt client is connected
      console.log('MQTT Client is connected.');
      mqttClient.subscribe(environment.mqttTopic);
    });;

    // React to message coming in on the topic and send it to IoT Central
    mqttClient.on('message', (topic, message) => {
      console.log('MQTT Message recieved. Topic: %s, Message: %s', topic, message);
      processMQTTMessage(message);

    })
  }
};

function processMQTTMessage(message){
  var msg = new Message(message);
  iotcClient.sendEvent(msg, (err, res) => console.log(`Sent message: ${msg.getData()}` +
  (err ? `; error: ${err.toString()}` : '') +
  (res ? `; status: ${res.constructor.name}` : '')));
}

// Function to enable the async processing of all interaction.
async function start(){
  iotcClient = Device.Client.fromConnectionString(await utils.getDeviceConnectionString(environment), DeviceTransport.Mqtt);
  iotcClient.open(connectCallback);
}

// Start the whole process async
start();