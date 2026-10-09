import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { mockState, MockPerson } from '../state.js';
import { resolveScenario } from '../scenarioResolver.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFields(request: FastifyRequest): Record<string, string> {
  const result: Record<string, string> = {};

  // Body parsed (từ @fastify/formbody hoặc JSON)
  if (request.body && typeof request.body === 'object') {
    for (const [key, val] of Object.entries(request.body as Record<string, any>)) {
      if (typeof val === 'object' && val !== null && val?.value !== undefined) {
        result[key] = String(val.value); // Định dạng multipart field của fastify
      } else if (typeof val !== 'object') {
        result[key] = String(val);
      }
    }
  }

  // Fallback sang Query parameters nếu client truyền query
  if (request.query && typeof request.query === 'object') {
    for (const [key, val] of Object.entries(request.query as Record<string, any>)) {
      if (!result[key] && val !== undefined) {
        result[key] = String(val);
      }
    }
  }

  return result;
}

export async function registerHanetRoutes(server: FastifyInstance): Promise<void> {
  // Hook xử lý Scenario trước khi vào handler
  const handleScenario = async (request: FastifyRequest) => {
    const { scenario, config } = resolveScenario(request);
    if (config.delayMs && config.delayMs > 0) {
      await sleep(config.delayMs);
    }
    if (scenario !== 'success') {
      return config.payload;
    }
    return null;
  };

  // 1. POST /person/registerByUrl
  server.post('/person/registerByUrl', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { name, aliasID, placeID, file_url, url, title } = fields;
    const finalUrl = file_url || url || 'https://static.hanet.ai/mock/face.jpg';

    if (!aliasID || !name || !placeID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: aliasID, name, and placeID are required',
        data: null
      });
    }

    const existing = mockState.getPersonByAlias(aliasID);
    if (existing) {
      return reply.status(200).send({
        returnCode: -9005,
        returnMessage: 'EMPLOYEE_IS_EXISTS',
        data: null
      });
    }

    const personID = `mock_pid_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const newPerson: MockPerson = {
      personID,
      aliasID,
      name,
      title: title || '',
      placeID,
      faceUrl: finalUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    mockState.savePerson(newPerson);

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        file: finalUrl,
        aliasID,
        name,
        personID,
        title: newPerson.title
      }
    });
  });

  // 2. POST /person/updateByFaceImage
  server.post('/person/updateByFaceImage', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { aliasID, placeID } = fields;

    if (!aliasID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: aliasID is required',
        data: null
      });
    }

    let person = mockState.getPersonByAlias(aliasID);
    const updatedUrl = `https://static.hanet.ai/mock/updated_${Date.now()}.jpg`;

    if (person) {
      person.faceUrl = updatedUrl;
      person.updatedAt = new Date().toISOString();
      mockState.savePerson(person);
    } else {
      person = {
        personID: `mock_pid_${Date.now()}`,
        aliasID,
        name: 'Auto-Created Person',
        placeID: placeID || 'default',
        faceUrl: updatedUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      mockState.savePerson(person);
    }

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        aliasID,
        file: updatedUrl
      }
    });
  });

  // 3. POST /person/updateByFaceImageByPersonID
  server.post('/person/updateByFaceImageByPersonID', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { personID } = fields;

    if (!personID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: personID is required',
        data: null
      });
    }

    const person = mockState.getPersonById(personID);
    if (!person) {
      return reply.status(200).send({
        returnCode: -5011,
        returnMessage: 'PERSON_NOT_FOUND_ERROR',
        data: null
      });
    }

    const updatedUrl = `https://static.hanet.ai/mock/person_${personID}_${Date.now()}.jpg`;
    person.faceUrl = updatedUrl;
    person.updatedAt = new Date().toISOString();
    mockState.savePerson(person);

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        personID,
        file: updatedUrl
      }
    });
  });

  // 4. POST /person/updateByFaceUrl
  server.post('/person/updateByFaceUrl', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { aliasID, file_url, url } = fields;
    const finalUrl = file_url || url || 'https://static.hanet.ai/mock/face.jpg';

    if (!aliasID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: aliasID is required',
        data: null
      });
    }

    const person = mockState.getPersonByAlias(aliasID);
    if (person) {
      person.faceUrl = finalUrl;
      person.updatedAt = new Date().toISOString();
      mockState.savePerson(person);
    }

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        aliasID,
        file: finalUrl
      }
    });
  });

  // 5. POST /person/updateByFaceUrlByAliasID
  server.post('/person/updateByFaceUrlByAliasID', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { aliasID, file_url, url } = fields;
    const finalUrl = file_url || url || 'https://static.hanet.ai/mock/face.jpg';

    if (!aliasID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: aliasID is required',
        data: null
      });
    }

    const person = mockState.getPersonByAlias(aliasID);
    if (person) {
      person.faceUrl = finalUrl;
      person.updatedAt = new Date().toISOString();
      mockState.savePerson(person);
    }

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        aliasID,
        file: finalUrl
      }
    });
  });

  // 6. POST /person/updateByFaceUrlByPersonID
  server.post('/person/updateByFaceUrlByPersonID', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { personID, file_url, url } = fields;
    const finalUrl = file_url || url || 'https://static.hanet.ai/mock/face.jpg';

    if (!personID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: personID is required',
        data: null
      });
    }

    const person = mockState.getPersonById(personID);
    if (!person) {
      return reply.status(200).send({
        returnCode: -5011,
        returnMessage: 'PERSON_NOT_FOUND_ERROR',
        data: null
      });
    }

    person.faceUrl = finalUrl;
    person.updatedAt = new Date().toISOString();
    mockState.savePerson(person);

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        personID,
        file: finalUrl
      }
    });
  });

  // 7. POST /person/removePersonByID
  server.post('/person/removePersonByID', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { personID } = fields;

    if (!personID) {
      return reply.status(200).send({
        returnCode: -1,
        returnMessage: 'INVALID_INPUT_ERROR: personID is required',
        data: null
      });
    }

    const removed = mockState.deletePerson(personID);
    if (!removed) {
      return reply.status(200).send({
        returnCode: -5011,
        returnMessage: 'PERSON_NOT_FOUND_ERROR',
        data: null
      });
    }

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: { personID }
    });
  });

  // 8. POST /person/getListByPlace
  server.post('/person/getListByPlace', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const snapshot = mockState.getSnapshot();
    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        total: snapshot.totalPersons,
        list: []
      }
    });
  });

  // 9. POST /person/getCheckinByPlaceIdInDay
  server.post('/person/getCheckinByPlaceIdInDay', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { placeID, date } = fields;

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: [
        {
          checkinID: 'mock_chk_1',
          placeID: placeID || '196',
          date: date || '2026-10-09',
          aliasID: 'TEST_STUDENT',
          time: '07:30:00'
        }
      ]
    });
  });

  // 10. POST /person/getCheckinByPlaceIdInTimestamp
  server.post('/person/getCheckinByPlaceIdInTimestamp', async (request, reply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    const { from, to: _to, placeID } = fields;

    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: [
        {
          checkinID: 'mock_chk_ts_1',
          placeID: placeID || '196',
          timestamp: Number(from) || Date.now(),
          aliasID: 'TEST_STUDENT'
        }
      ]
    });
  });

  // 11. POST /device/getConnectionStatus & /device/get-connection-status
  const handleDeviceStatus = async (request: FastifyRequest, reply: FastifyReply) => {
    const intercepted = await handleScenario(request);
    if (intercepted) return reply.status(200).send(intercepted);

    const fields = parseFields(request);
    return reply.status(200).send({
      returnCode: 1,
      returnMessage: 'SUCCESS',
      data: {
        deviceID: fields.deviceID || 'C20371B302',
        status: 1
      }
    });
  };

  server.post('/device/getConnectionStatus', handleDeviceStatus);
  server.post('/device/get-connection-status', handleDeviceStatus);
}
