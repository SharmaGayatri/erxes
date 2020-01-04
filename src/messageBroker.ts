import * as amqplib from 'amqplib';
import * as dotenv from 'dotenv';
import * as uuid from 'uuid';
import { receiveIntegrationsNotification, receiveRpcMessage } from './data/modules/integrations/receiveMessage';
import { conversationNotifReceivers } from './data/resolvers/mutations/conversations';
import { registerOnboardHistory, sendMobileNotification } from './data/utils';
import { ActivityLogs, Conversations, Customers, Integrations, RobotEntries, Users } from './db/models';
import { debugBase } from './debuggers';
import { graphqlPubsub } from './pubsub';
import { get, set } from './redisClient';

dotenv.config();

const { NODE_ENV, RABBITMQ_HOST = 'amqp://localhost' } = process.env;

interface IWidgetMessage {
  action: string;
  data: {
    trigger: string;
    type: string;
    payload: any;
  };
}

let connection;
let channel;

const receiveWidgetNotification = async ({ action, data }: IWidgetMessage) => {
  if (NODE_ENV === 'test') {
    return;
  }

  if (action === 'callPublish') {
    if (data.trigger === 'conversationMessageInserted') {
      const { customerId, conversationId, content } = data.payload;
      const conversation = await Conversations.findOne(
        { _id: conversationId },
        {
          integrationId: 1,
          participatedUserIds: 1,
          assignedUserId: 1,
        },
      );
      const customerLastStatus = await get(`customer_last_status_${customerId}`);

      // if customer's last status is left then mark as joined when customer ask
      if (conversation) {
        if (customerLastStatus === 'left') {
          set(`customer_last_status_${customerId}`, 'joined');

          // customer has joined + time
          const conversationMessages = await Conversations.changeCustomerStatus(
            'joined',
            customerId,
            conversation.integrationId,
          );

          for (const message of conversationMessages) {
            graphqlPubsub.publish('conversationMessageInserted', {
              conversationMessageInserted: message,
            });
          }

          // notify as connected
          graphqlPubsub.publish('customerConnectionChanged', {
            customerConnectionChanged: {
              _id: customerId,
              status: 'connected',
            },
          });
        }

        sendMobileNotification({
          title: 'You have a new message',
          body: content,
          customerId,
          conversationId,
          receivers: conversationNotifReceivers(conversation, customerId),
        });
      }
    }

    graphqlPubsub.publish(data.trigger, { [data.trigger]: data.payload });
  }

  if (action === 'activityLog') {
    ActivityLogs.createLogFromWidget(data.type, data.payload);
  }

  if (action === 'leadInstalled') {
    const integration = await Integrations.findOne({ _id: data.payload.integrationId });

    if (!integration) {
      return;
    }

    const user = await Users.findOne({ _id: integration.createdUserId });

    if (!user) {
      return;
    }

    registerOnboardHistory({ type: 'leadIntegrationInstalled', user });
  }
};

export const sendRPCMessage = async (message): Promise<any> => {
  const response = await new Promise((resolve, reject) => {
    const correlationId = uuid();

    return channel.assertQueue('', { exclusive: true }).then(q => {
      channel.consume(
        q.queue,
        msg => {
          if (!msg) {
            return reject(new Error('consumer cancelled by rabbitmq'));
          }

          if (msg.properties.correlationId === correlationId) {
            const res = JSON.parse(msg.content.toString());

            if (res.status === 'success') {
              resolve(res.data);
            } else {
              reject(res.errorMessage);
            }

            channel.deleteQueue(q.queue);
          }
        },
        { noAck: true },
      );

      channel.sendToQueue('rpc_queue:erxes-api', Buffer.from(JSON.stringify(message)), {
        correlationId,
        replyTo: q.queue,
      });
    });
  });

  return response;
};

export const sendMessage = async (queueName: string, data?: any) => {
  await channel.assertQueue(queueName);
  await channel.sendToQueue(queueName, Buffer.from(JSON.stringify(data || {})));
};

const initConsumer = async () => {
  // Consumer
  try {
    connection = await amqplib.connect(RABBITMQ_HOST);
    channel = await connection.createChannel();

    // listen for rpc queue =========
    await channel.assertQueue('rpc_queue:erxes-integrations');

    channel.consume('rpc_queue:erxes-integrations', async msg => {
      if (msg !== null) {
        debugBase(`Received rpc queue message ${msg.content.toString()}`);

        const response = await receiveRpcMessage(JSON.parse(msg.content.toString()));

        channel.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(response)), {
          correlationId: msg.properties.correlationId,
        });

        channel.ack(msg);
      }
    });

    // graphql subscriptions call =========
    await channel.assertQueue('callPublish');

    channel.consume('callPublish', async msg => {
      if (msg !== null) {
        const params = JSON.parse(msg.content.toString());

        graphqlPubsub.publish(params.name, params.data);

        channel.ack(msg);
      }
    });

    // listen for widgets api =========
    await channel.assertQueue('widgetNotification');

    channel.consume('widgetNotification', async msg => {
      if (msg !== null) {
        await receiveWidgetNotification(JSON.parse(msg.content.toString()));
        channel.ack(msg);
      }
    });

    // listen for integrations api =========
    await channel.assertQueue('integrationsNotification');

    channel.consume('integrationsNotification', async msg => {
      if (msg !== null) {
        await receiveIntegrationsNotification(JSON.parse(msg.content.toString()));
        channel.ack(msg);
      }
    });

    // listen for engage api ===========
    await channel.assertQueue('engages-api:set-donot-disturb');

    channel.consume('engages-api:set-donot-disturb', async msg => {
      if (msg !== null) {
        const data = JSON.parse(msg.content.toString());

        await Customers.updateOne({ _id: data.customerId }, { $set: { doNotDisturb: 'Yes' } });

        channel.ack(msg);
      }
    });

    // listen for spark notification  =========
    await channel.assertQueue('sparkNotification');

    channel.consume('sparkNotification', async msg => {
      if (msg !== null) {
        debugBase(`Received spark notification ${msg.content.toString()}`);

        const data = JSON.parse(msg.content.toString());

        delete data.subdomain;

        RobotEntries.createEntry(data)
          .then(() => debugBase('success'))
          .catch(e => debugBase(e.message));

        channel.ack(msg);
      }
    });
  } catch (e) {
    debugBase(e.message);
  }
};

initConsumer();
