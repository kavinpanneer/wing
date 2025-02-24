import { test, expect } from "vitest";
import {
  listMessages,
  treeJsonOf,
  waitUntilTrace,
  waitUntilTraceCount,
} from "./util";
import * as cloud from "../../src/cloud";
import { Duration, Node } from "../../src/std";
import { QUEUE_TYPE } from "../../src/target-sim/schema-resources";
import { Testing } from "../../src/testing";
import { SimApp } from "../sim-app";

const INFLIGHT_CODE = `
async handle(message) {
  if (message === "BAD MESSAGE") {
    throw new Error("ERROR");
  }
}`;

test("create a queue", async () => {
  // GIVEN
  const app = new SimApp();
  cloud.Queue._newQueue(app, "my_queue");
  const s = await app.startSimulator();

  // THEN
  await s.stop();
  expect(s.getResourceConfig("/my_queue")).toMatchInlineSnapshot(`
    {
      "attrs": {
        "handle": "sim-1",
      },
      "path": "root/my_queue",
      "props": {
        "retentionPeriod": 3600,
        "timeout": 10,
      },
      "type": "wingsdk.cloud.Queue",
    }
  `);

  expect(app.snapshot()).toMatchSnapshot();
});

test("queue with one subscriber, default batch size of 1", async () => {
  // GIVEN
  const app = new SimApp();
  const handler = Testing.makeHandler(app, "Handler", INFLIGHT_CODE);
  const queue = cloud.Queue._newQueue(app, "my_queue");
  queue.setConsumer(handler);
  const s = await app.startSimulator();

  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;

  // WHEN
  await queueClient.push("A", "B");
  await waitUntilTraceCount(s, 2, (trace) =>
    trace.data.message.startsWith("Sending messages")
  );

  // THEN
  await s.stop();

  expect(listMessages(s)).toMatchSnapshot();
  expect(app.snapshot()).toMatchSnapshot();
});

test("queue batch size of 2, purge the queue", async () => {
  // GIVEN
  const QUEUE_SIZE = 2;
  const QUEUE_EMPTY_SIZE = 0;
  const app = new SimApp();
  cloud.Queue._newQueue(app, "my_queue");
  const s = await app.startSimulator();

  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;

  // WHEN
  await queueClient.push("A");
  await queueClient.push("B");

  let approxSize = await queueClient.approxSize();

  expect(approxSize).toEqual(QUEUE_SIZE);

  await queueClient.purge();

  approxSize = await queueClient.approxSize();
  expect(approxSize).toEqual(QUEUE_EMPTY_SIZE);

  // THEN
  await s.stop();

  expect(listMessages(s)).toMatchSnapshot();
  expect(app.snapshot()).toMatchSnapshot();
});

test("queue with one subscriber, batch size of 5", async () => {
  // GIVEN
  const app = new SimApp();

  const queue = cloud.Queue._newQueue(app, "my_queue");
  const handler = Testing.makeHandler(app, "Handler", INFLIGHT_CODE);
  const consumer = queue.setConsumer(handler, { batchSize: 5 });

  // initialize the queue with some messages
  const onDeployHandler = Testing.makeHandler(
    app,
    "OnDeployHandler",
    `\
async handle() {
  await this.queue.push("A");
  await this.queue.push("B");
  await this.queue.push("C");
  await this.queue.push("D");
  await this.queue.push("E");
  await this.queue.push("F");
}`,
    {
      queue: {
        obj: queue,
        ops: [cloud.QueueInflightMethods.PUSH],
      },
    }
  );
  cloud.OnDeploy._newOnDeploy(app, "my_queue_messages", onDeployHandler);

  const s = await app.startSimulator();

  // WHEN
  await waitUntilTraceCount(
    s,
    2,
    (trace) =>
      trace.sourcePath === consumer.node.path && trace.data.status === "success"
  );

  // THEN
  await s.stop();

  const traces = s.listTraces().map((trace) => trace.data.message);
  expect(traces).toContain(
    'Invoke (payload="{\\"messages\\":[\\"A\\",\\"B\\",\\"C\\",\\"D\\",\\"E\\"]}").'
  );
  expect(traces).toContain('Invoke (payload="{\\"messages\\":[\\"F\\"]}").');
  expect(app.snapshot()).toMatchSnapshot();
});

test("messages are requeued if the function fails after timeout", async () => {
  // GIVEN
  const app = new SimApp();
  const handler = Testing.makeHandler(app, "Handler", INFLIGHT_CODE);
  const queue = cloud.Queue._newQueue(app, "my_queue", {
    timeout: Duration.fromSeconds(1),
  });
  queue.setConsumer(handler);
  const s = await app.startSimulator();

  // WHEN
  const REQUEUE_MSG =
    "1 messages pushed back to queue after visibility timeout.";
  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;
  void queueClient.push("BAD MESSAGE");
  await waitUntilTrace(s, (trace) => trace.data.message.startsWith("Invoke"));
  // stopping early to avoid the next queue message from being processed
  await s.stop();

  // THEN
  await waitUntilTrace(s, (trace) =>
    trace.data.message.startsWith(REQUEUE_MSG)
  );
  expect(listMessages(s)).toMatchSnapshot();
  expect(app.snapshot()).toMatchSnapshot();

  expect(
    s
      .listTraces()
      .filter((v) => v.sourceType == QUEUE_TYPE)
      .map((trace) => trace.data.message)
  ).toContain(REQUEUE_MSG);
});

test("messages are not requeued if the function fails before timeout", async () => {
  // GIVEN
  const app = new SimApp();
  const handler = Testing.makeHandler(app, "Handler", INFLIGHT_CODE);
  const queue = cloud.Queue._newQueue(app, "my_queue", {
    timeout: Duration.fromSeconds(30),
  });
  queue.setConsumer(handler);
  const s = await app.startSimulator();

  // WHEN
  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;
  void queueClient.push("BAD MESSAGE");
  await waitUntilTrace(
    s,
    (trace) =>
      trace.data.message ==
      "Subscriber error - returning 1 messages to queue: ERROR"
  );

  // THEN
  await s.stop();

  expect(listMessages(s)).toMatchSnapshot();
  expect(app.snapshot()).toMatchSnapshot();

  expect(
    s
      .listTraces()
      .filter((v) => v.sourceType == QUEUE_TYPE)
      .map((trace) => trace.data.message)
  ).toMatchInlineSnapshot(`
    [
      "wingsdk.cloud.Queue created.",
      "Push (messages=BAD MESSAGE).",
      "Sending messages (messages=[\\"BAD MESSAGE\\"], subscriber=sim-1).",
      "Subscriber error - returning 1 messages to queue: ERROR",
      "wingsdk.cloud.Queue deleted.",
    ]
  `);
});

test("messages are not requeued if the function fails after retention timeout", async () => {
  // GIVEN
  const app = new SimApp();
  const handler = Testing.makeHandler(app, "Handler", INFLIGHT_CODE);
  const queue = cloud.Queue._newQueue(app, "my_queue", {
    retentionPeriod: Duration.fromSeconds(1),
  });
  queue.setConsumer(handler);
  const s = await app.startSimulator();

  // WHEN
  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;
  void queueClient.push("BAD MESSAGE");
  await waitUntilTrace(
    s,
    (trace) =>
      trace.data.message ==
      "Subscriber error - returning 1 messages to queue: ERROR"
  );

  // THEN
  await s.stop();

  expect(listMessages(s)).toMatchSnapshot();
  expect(app.snapshot()).toMatchSnapshot();

  expect(
    s
      .listTraces()
      .filter((v) => v.sourceType == QUEUE_TYPE)
      .map((trace) => trace.data.message)
  ).toMatchInlineSnapshot(`
    [
      "wingsdk.cloud.Queue created.",
      "Push (messages=BAD MESSAGE).",
      "Sending messages (messages=[\\"BAD MESSAGE\\"], subscriber=sim-1).",
      "Subscriber error - returning 1 messages to queue: ERROR",
      "wingsdk.cloud.Queue deleted.",
    ]
  `);
});

test("queue has no display hidden property", async () => {
  // GIVEN
  const app = new SimApp();
  cloud.Queue._newQueue(app, "my_queue");

  const treeJson = treeJsonOf(app.synth());
  const queue = app.node.tryFindChild("my_queue") as cloud.Queue;

  // THEN
  expect(Node.of(queue).hidden).toBeUndefined();
  expect(treeJson.tree.children).toBeDefined();
  expect(treeJson.tree.children).not.toMatchObject({
    my_queue: {
      display: {
        hidden: expect.any(Boolean),
      },
    },
  });
});

test("queue has display title and description properties", async () => {
  // GIVEN
  const app = new SimApp();
  cloud.Queue._newQueue(app, "my_queue");

  // WHEN
  const treeJson = treeJsonOf(app.synth());
  const queue = app.node.tryFindChild("my_queue") as cloud.Queue;

  // THEN
  expect(Node.of(queue).title).toBeDefined();
  expect(Node.of(queue).description).toBeDefined();
  expect(treeJson.tree.children).toMatchObject({
    my_queue: {
      display: {
        title: expect.any(String),
        description: expect.any(String),
      },
    },
  });
});

test("can pop messages from queue", async () => {
  // GIVEN
  const app = new SimApp();
  const messages = ["A", "B", "C", "D", "E", "F"];
  cloud.Queue._newQueue(app, "my_queue");

  // WHEN
  const s = await app.startSimulator();
  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;

  // initialize the messages
  for (const message of messages) {
    await queueClient.push(message);
  }

  // try popping them
  const poppedMessages: Array<string | undefined> = [];
  for (let i = 0; i < messages.length; i++) {
    poppedMessages.push(await queueClient.pop());
  }
  const poppedOnEmptyQueue = await queueClient.pop();

  // THEN
  await s.stop();
  expect(poppedMessages).toEqual(messages);
  expect(poppedOnEmptyQueue).toBeUndefined();
});

test("pop from empty queue returns nothing", async () => {
  // GIVEN
  const app = new SimApp();
  cloud.Queue._newQueue(app, "my_queue");

  // WHEN
  const s = await app.startSimulator();
  const queueClient = s.getResource("/my_queue") as cloud.IQueueClient;
  const popped = await queueClient.pop();

  // THEN
  await s.stop();
  expect(popped).toBeUndefined();
});
