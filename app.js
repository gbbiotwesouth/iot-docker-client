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
  deviceMethods: process.env.DEVICE_METHODS,
  mqttBroker: process.env.MQTT_BROKER,
  mqttSubscribeTopic: process.env.MQTT_SUBSCRIBE_TOPIC,
  mqttPublishTopic: process.env.MQTT_PUBLISH_TOPIC
};

var mqttClient;
var iotcClient;

// Handle settings changes that come from Azure IoT Central via the device twin.
function handleSettings(twin) {
  twin.on('properties.desired', function (desiredChange) {
    for (let setting in desiredChange) {
      // make sure it is a property and not metadata '$'
      if (setting.charAt(0) != '$'){
        var newValue = desiredChange[setting].value.toString();
        console.log(`Received setting: ${setting}: ${newValue}`);
        var patch = {
          [setting]: {
            value: newValue,
            status: 'completed',
            desiredVersion: desiredChange.$version,
            message: ''
          }
        }
        // Send pending response to IoT Central, later to be updated by response from MQTT response
        twin.properties.reported.update(patch, (err) => console.log(`Sent setting update for ${setting}; ` +
          (err ? `error: ${err.toString()}` : `status: success`)));
        // Send device twin changes to MQTT broker, topic = setting, content = value
        mqttClient.publish(mqttPublishTopic + '/' + setting, newValue);
        }
    }
  });
}

// Respond to the echo command
function onCommand(request, response) {
  // Display console info
  console.log(' * Device method received: %s', request.methodName);
  // publish method to MQTT Broker using methodname as topic and payload as content
  mqttClient.publish(mqttPublishTopic + '/' + request.methodName, JSON.stringify(request.payload));
  // Respond with succes (as we can't wait for the actual response)
  response.send(10, 'Success', function (errorMessage) {});
}

// Handle device connection to Azure IoT Central.
var connectCallback = (err) => {
  if (err) {
    console.log(`Device could not connect to Azure IoT Central: ${err.toString()}`);
  } else {
    console.log('Device successfully connected to Azure IoT Central');

    // Setup device command callbacks
    var cmds = environment.deviceMethods.split(",");
    for (var i = 0; i < cmds.length; i++){
      console.log('Subscribe to device method: %s', cmds[i]);
      iotcClient.onDeviceMethod(cmds[i], onCommand);
    }

    // Get device twin from Azure IoT Central.
    iotcClient.getTwin((err, twin) => {
      if (err) {
        console.log(`Error getting device twin: ${err.toString()}`);
      } else {
        console.log(`Succesfully getting device twin.`);
        // Apply device settings and handle changes to device settings.
        handleSettings(twin);
        
        // Start listening to the MQTT communication
        if (mqttClient){
          mqttClient.close();
        }
        mqttClient = mqtt.connect('mqtt://' + environment.mqttBroker);
        mqttClient.on('connect', () => {
          // Inform controllers that mqtt client is connected
          console.log('MQTT Client is connected.');
          mqttClient.subscribe(environment.mqttSubscribeTopic);
        });;

        // React to message coming in on the topic and send it to IoT Central
        mqttClient.on('message', (topic, message) => {
          console.log('MQTT Message recieved. Topic: %s, Message: %s', topic, message);
          processMQTTMessage(twin, message);
        })
      }
    });
  }
};

function processMQTTMessage(twin, message){
  // Turn the message into json to be able to work teh deifferent parts
  var data = JSON.parse(message);

  // check for part existance and process accordingly
  // Properties
  if (data.properties)
  {
    twin.properties.reported.update(data.properties, (err) => console.log(`Sent update for properties: ` +
    (err ? `error: ${err.toString()}` : `status: success`)));
  }
  // Telemetry
  if (data.telemetry)
  {
    // Send the telemetry
    sendData(data.telemetry);
  } 
  //State
  if (data.state)
  {
    // Send the state
    sendData(data.state);
  }
  // Event
  if (data.event)
  {
    // Send the event
    sendData(data.event);
  }
}

// Function to send the data to IoT Central
function sendData(data){
  var message = new Message(JSON.stringify(data));
  iotcClient.sendEvent(message, (err, res) => console.log(`Sent message: ${message.getData()}` +
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