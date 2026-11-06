require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const app = express();
const port = process.env.PORT || 8000;

app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// ---------- Database ----------
const client = new MongoClient(process.env.MONGODB_URI);
let collections;

async function getCollections() {
  if (!collections) {
    await client.connect();
    const db = client.db("handinhand");
    collections = {
      events: db.collection("events"),
      joinedEvents: db.collection("joinedEvents"),
    };
  }
  return collections;
}

// ---------- JWT verification (tokens are issued by Better Auth on the client app) ----------
let jwks;

const verifyToken = async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || "").split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  try {
    jwks = jwks || createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));
    const { payload } = await jwtVerify(token, jwks);
    req.user = payload;
    next();
  } catch {
    res.status(401).send({ message: "Unauthorized access" });
  }
};

// ---------- Helpers ----------
const EVENT_TYPES = [
  "Cleanup",
  "Plantation",
  "Donation",
  "Food Distribution",
  "Health Camp",
  "Education",
];

// Event dates are "YYYY-MM-DD" strings compared against today's date in Dhaka.
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });

const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

function parseEvent(body = {}) {
  const data = {
    title: String(body.title ?? "").trim(),
    description: String(body.description ?? "").trim(),
    eventType: String(body.eventType ?? ""),
    imageUrl: String(body.imageUrl ?? "").trim(),
    location: String(body.location ?? "").trim(),
    eventDate: String(body.eventDate ?? ""),
  };

  if (data.title.length < 5) {
    return { error: "Event title must be at least 5 characters long." };
  }
  if (!EVENT_TYPES.includes(data.eventType)) {
    return { error: "Please choose a valid event type." };
  }
  if (data.location.length < 3) {
    return { error: "Please enter the event location." };
  }
  if (!isHttpsUrl(data.imageUrl)) {
    return { error: "Thumbnail must be a valid image URL starting with https://" };
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(data.eventDate) ||
    Number.isNaN(Date.parse(data.eventDate))
  ) {
    return { error: "Please provide a valid event date." };
  }
  if (data.eventDate <= today()) {
    return { error: "Event date must be in the future." };
  }
  if (data.description.length < 20) {
    return { error: "Description must be at least 20 characters long." };
  }

  return { data };
}

const findEvent = async (id) => {
  if (!ObjectId.isValid(id)) return null;
  const { events } = await getCollections();
  return events.findOne({ _id: new ObjectId(id) });
};

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send("HandInHand server is running");
});

// Create an event (private)
app.post("/add-event", verifyToken, async (req, res) => {
  const { error, data } = parseEvent(req.body);
  if (error) return res.status(400).send({ message: error });

  const { events } = await getCollections();
  const result = await events.insertOne({
    ...data,
    email: req.user.email,
    createdAt: new Date(),
  });

  res.status(201).send({ success: true, insertedId: result.insertedId });
});

// All upcoming events (public)
app.get("/events", async (req, res) => {
  const { events } = await getCollections();
  const result = await events
    .find({ eventDate: { $gte: today() } })
    .sort({ eventDate: 1 })
    .toArray();

  res.send(result);
});

// 6 recent upcoming events for the home page (public)
app.get("/recent-events", async (req, res) => {
  const { events } = await getCollections();
  const result = await events
    .find({ eventDate: { $gte: today() } })
    .sort({ eventDate: 1 })
    .limit(6)
    .toArray();

  res.send(result);
});

// Single event (public)
app.get("/event/:id", async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) return res.status(404).send({ message: "Event not found" });

  res.send(event);
});

// Update an event (owner only)
app.patch("/event/:id", verifyToken, async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) return res.status(404).send({ message: "Event not found" });

  if (event.email !== req.user.email) {
    return res.status(403).send({ message: "You can only update your own events" });
  }

  const { error, data } = parseEvent(req.body);
  if (error) return res.status(400).send({ message: error });

  const { events } = await getCollections();
  const result = await events.updateOne({ _id: event._id }, { $set: data });

  res.send({ success: true, modifiedCount: result.modifiedCount });
});

// Delete an event (owner only)
app.delete("/event/:id", verifyToken, async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) return res.status(404).send({ message: "Event not found" });

  if (event.email !== req.user.email) {
    return res.status(403).send({ message: "You can only delete your own events" });
  }

  const { events, joinedEvents } = await getCollections();
  const result = await events.deleteOne({ _id: event._id });
  await joinedEvents.deleteMany({ eventId: String(event._id) });

  res.send({ success: true, deletedCount: result.deletedCount });
});

// Events created by the logged-in user (private)
app.get("/manage-events/:email", verifyToken, async (req, res) => {
  if (req.user.email !== req.params.email) {
    return res.status(403).send({ message: "Forbidden access" });
  }

  const { events } = await getCollections();
  const result = await events
    .find({ email: req.params.email })
    .sort({ eventDate: 1 })
    .toArray();

  res.send(result);
});

// Join an event (private)
app.post("/join-event", verifyToken, async (req, res) => {
  const event = await findEvent(req.body?.eventId);
  if (!event) return res.status(404).send({ message: "Event not found" });

  if (event.eventDate < today()) {
    return res.status(400).send({ message: "This event has already ended" });
  }

  const { joinedEvents } = await getCollections();
  const eventId = String(event._id);

  const alreadyJoined = await joinedEvents.findOne({
    eventId,
    email: req.user.email,
  });
  if (alreadyJoined) {
    return res.status(409).send({ message: "You have already joined this event" });
  }

  const result = await joinedEvents.insertOne({
    eventId,
    email: req.user.email,
    username: req.user.name,
    image: req.user.image || "",
    title: event.title,
    description: event.description,
    eventType: event.eventType,
    imageUrl: event.imageUrl,
    location: event.location,
    eventDate: event.eventDate,
    joinedAt: new Date(),
  });

  res.status(201).send({ success: true, insertedId: result.insertedId });
});

// Events joined by the logged-in user, sorted by event date (private)
app.get("/joined-events/:email", verifyToken, async (req, res) => {
  if (req.user.email !== req.params.email) {
    return res.status(403).send({ message: "Forbidden access" });
  }

  const { joinedEvents } = await getCollections();
  const result = await joinedEvents
    .find({ email: req.params.email })
    .sort({ eventDate: 1 })
    .toArray();

  res.send(result);
});

// Unexpected errors
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send({ message: "Something went wrong on the server" });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`HandInHand server listening on port ${port}`);
  });
}

module.exports = app;
