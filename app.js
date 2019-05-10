// IoT Central Client Module 
'use strict';

const DeviceTransport = require('azure-iot-device-mqtt');
const Device = require('azure-iot-device');
const Message = require('azure-iot-device').Message;
const mqtt = require("mqtt");
const request = require('request-promise-native');
const crypto = require('crypto');
const util = require('util');

const registrationHost = 'global.azure-devices-provisioning.net';
const registrationSasTtl = 3600; // 1 hour
const registrationApiVersion = `2018-11-01`;
const registrationStatusQueryAttempts = 10;
const registrationStatusQueryTimeout = 2000;
const minDeviceRegistrationTimeout = 60*1000; // 1 minute

const deviceCache = {};

var on_state = false;

const environment = {
  idScope: process.env.ID_SCOPE,
  primaryKey: process.env.IOTC_SAS_KEY,
  deviceId: process.env.DEVICE_ID,
  mqttBroker: process.env.MQTT_BROKER,
  mqttTopic: process.env.MQTT_TOPIC
};

var mqttClient;
var iotcClient;
var runningSeconds = 0;

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
      on_state = newValue;
      callback(on_state, 'completed');
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
      console.log('Topic: %s, Message: %s', topic, message);
      var json = JSON.parse(message);
      if (on_state == true){
        json.operating_status = "1";
      }
      else {
        json.operating_status = "0";
      }

      if (json.operating_status == 1){
        runningSeconds = runningSeconds + 5;
        console.log("Update running hours: %f", Math.round((runningSeconds/3600)*1000)/1000);
        sendDeviceProperties(clientTwin);
      }
      var msg = new Message(JSON.stringify(json));
      iotcClient.sendEvent(msg, (err, res) => console.log(`Sent message: ${msg.getData()}` +
      (err ? `; error: ${err.toString()}` : '') +
      (res ? `; status: ${res.constructor.name}` : '')));
    })
  }
};

/*
* Get device connection string using device provisioning for IOTC
*/
async function getDeviceConnectionString() {
  const deviceId = environment.deviceId;

  if (deviceCache[deviceId] && deviceCache[deviceId].connectionString) {
      return deviceCache[deviceId].connectionString;
  }

  const connStr = `HostName=${await getDeviceHub()};DeviceId=${deviceId};SharedAccessKey=${await getDeviceKey()}`;
  deviceCache[deviceId].connectionString = connStr;
  return connStr;
}

/**
* Registers this device with DPS, returning the IoT Hub assigned to it.
*/
async function getDeviceHub() {
  const deviceId = environment.deviceId;
  const now = Date.now();

  // A 1 minute backoff is enforced for registration attempts, to prevent unauthorized devices
  // from trying to re-register too often.
  if (deviceCache[deviceId] && deviceCache[deviceId].lasRegisterAttempt && (now - deviceCache[deviceId].lasRegisterAttempt) < minDeviceRegistrationTimeout) {
      const backoff = Math.floor((minDeviceRegistrationTimeout - (now - deviceCache[deviceId].lasRegisterAttempt)) / 1000);
      throw new StatusError(`Unable to register device ${deviceId}. Minimum registration timeout not yet exceeded. Please try again in ${backoff} seconds`, 403);
  }

  deviceCache[deviceId] = {
      ...deviceCache[deviceId],
      lasRegisterAttempt: Date.now()
  }

  const sasToken = await getRegistrationSasToken(deviceId);

  const registrationOptions = {
      url: `https://${registrationHost}/${environment.idScope}/registrations/${deviceId}/register?api-version=${registrationApiVersion}`,
      method: 'PUT',
      json: true,
      headers: { Authorization: sasToken },
      body: { registrationId: deviceId }
  };

  try {
      console.log('[HTTP] Initiating device registration');
      const response = await request(registrationOptions);

      if (response.status !== 'assigning' || !response.operationId) {
          throw new Error('Unknown server response');
      }

      const statusOptions = {
          url: `https://${registrationHost}/${environment.idScope}/registrations/${deviceId}/operations/${response.operationId}?api-version=${registrationApiVersion}`,
          method: 'GET',
          json: true,
          headers: { Authorization: sasToken }
      };

      // The first registration call starts the process, we then query the registration status
      // every 2 seconds, up to 10 times.
      for (let i = 0; i < registrationStatusQueryAttempts; ++i) {
          await new Promise(resolve => setTimeout(resolve, registrationStatusQueryTimeout));

          console.log('[HTTP] Querying device registration status');
          const statusResponse = await request(statusOptions);

          if (statusResponse.status === 'assigning') {
              continue;
          } else if (statusResponse.status === 'assigned' && statusResponse.registrationState && statusResponse.registrationState.assignedHub) {
              return statusResponse.registrationState.assignedHub;
          } else if (statusResponse.status === 'failed' && statusResponse.registrationState && statusResponse.registrationState.errorCode === 400209) {
              throw new Error('The device may be unassociated or blocked');
          } else {
              throw new Error('Unknown server response');
          }
      }

      throw new Error('Registration was not successful after maximum number of attempts');
  } catch (e) {
      throw new Error(`Unable to register device ${deviceId}: ${e.message}`, e.statusCode);
  }
}

async function getRegistrationSasToken(deviceId) {
  const uri = encodeURIComponent(`${environment.idScope}/registrations/${deviceId}`);
  const ttl = Math.round(Date.now() / 1000) + registrationSasTtl;
  const signature = crypto.createHmac('sha256', new Buffer(await getDeviceKey(), 'base64'))
      .update(`${uri}\n${ttl}`)
      .digest('base64');
  return`SharedAccessSignature sr=${uri}&sig=${encodeURIComponent(signature)}&skn=registration&se=${ttl}`;
}

/**
* Computes a derived device key using the primary key.
*/
async function getDeviceKey() {
  var deviceId = environment.deviceId;
  if (deviceCache[deviceId] && deviceCache[deviceId].deviceKey) {
      return deviceCache[deviceId].deviceKey;
  }

  const key = crypto.createHmac('SHA256', new Buffer(environment.primaryKey, 'base64'))
      .update(deviceId)
      .digest()
      .toString('base64');

  deviceCache[deviceId].deviceKey = key;
  return key;
}

// Function to enable the async processing of all interaction.
async function start(){
  iotcClient = Device.Client.fromConnectionString(await getDeviceConnectionString(), DeviceTransport.Mqtt);
  iotcClient.open(connectCallback);
}

// Start the whole process async
start();