'use strict';

const request = require('request-promise-native');
const crypto = require('crypto');

const registrationHost = 'global.azure-devices-provisioning.net';
const registrationSasTtl = 3600; // 1 hour
const registrationApiVersion = `2018-11-01`;
const registrationStatusQueryAttempts = 10;
const registrationStatusQueryTimeout = 2000;
const minDeviceRegistrationTimeout = 60*1000; // 1 minute

var deviceCache = {};

/*
* Get device connection string using device provisioning for IOTC
*/
module.exports = {
    getDeviceConnectionString: async function (environment) {
    const deviceId = environment.deviceId;

    if (deviceCache[deviceId] && deviceCache[deviceId].connectionString) {
        return deviceCache[deviceId].connectionString;
    }

    const connStr = `HostName=${await getDeviceHub(environment)};DeviceId=${deviceId};SharedAccessKey=${await getDeviceKey(environment)}`;
    deviceCache[deviceId].connectionString = connStr;
    return connStr;
    }
}
  
/**
 * Registers this device with DPS, returning the IoT Hub assigned to it.
 */
async function getDeviceHub(environment) {
    const deviceId = environment.deviceId;
    const now = Date.now();

    // A 1 minute backoff is enforced for registration attempts, to prevent unauthorized devices
    // from trying to re-register too often.
    if (deviceCache[deviceId] && deviceCache[deviceId].lasRegisterAttempt && (now - deviceCache[deviceId].lasRegisterAttempt) < minDeviceRegistrationTimeout) {
        const backoff = Math.floor((minDeviceRegistrationTimeout - (now - device[deviceId].lasRegisterAttempt)) / 1000);
        throw new StatusError(`Unable to register device ${deviceId}. Minimum registration timeout not yet exceeded. Please try again in ${backoff} seconds`, 403);
    }

    deviceCache[deviceId] = {
        ...deviceCache[deviceId],
        lasRegisterAttempt: Date.now()
    }

    const sasToken = await getRegistrationSasToken(environment);

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

async function getRegistrationSasToken(environment) {
    const uri = encodeURIComponent(`${environment.idScope}/registrations/${environment.deviceId}`);
    const ttl = Math.round(Date.now() / 1000) + registrationSasTtl;
    const signature = crypto.createHmac('sha256', Buffer.from(await getDeviceKey(environment), 'base64'))
        .update(`${uri}\n${ttl}`)
        .digest('base64');
    return`SharedAccessSignature sr=${uri}&sig=${encodeURIComponent(signature)}&skn=registration&se=${ttl}`;
}

/**
 * Computes a derived device key using the primary key.
 */
async function getDeviceKey(environment) {
    var deviceId = environment.deviceId;
    if (deviceCache[deviceId] && deviceCache[deviceId].deviceKey) {
        return deviceCache[deviceId].deviceKey;
    }

    const key = crypto.createHmac('SHA256', Buffer.from(environment.primaryKey, 'base64'))
        .update(deviceId)
        .digest()
        .toString('base64');

    deviceCache[deviceId].deviceKey = key;
    return key;
}