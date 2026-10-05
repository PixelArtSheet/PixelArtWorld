import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRICE_CENTS = Number(
  process.env.PIXEL_PRICE_CENTS || 10
);

const CURRENCY =
  process.env.PIXEL_CURRENCY || "eur";

const SIZE = 1000;

/*
  Stripe webhook MUST receive the raw body,
  so this route is placed before express.json().
*/
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {

    const signature =
      req.headers["stripe-signature"];

    let event;

    try {

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );

    } catch (error) {

      console.error(
        "Webhook error:",
        error.message
      );

      return res.status(400).send(
        `Webhook Error: ${error.message}`
      );
    }

    try {

      if (
        event.type ===
        "checkout.session.completed"
      ) {

        const session = event.data.object;

        const {
          x,
          y,
          color,
          username
        } = session.metadata || {};

        if (
          session.payment_status !== "paid" ||
          x === undefined ||
          y === undefined ||
          !color ||
          !username
        ) {

          return res.json({
            received: true
          });
        }

        const { data: reservation } =
          await supabase
            .from("pixel_reservations")
            .select("*")
            .eq("x", Number(x))
            .eq("y", Number(y))
            .eq(
              "session_id",
              session.id
            )
            .maybeSingle();

        if (!reservation) {

          console.log(
            "Reservation not found:",
            session.id
          );

          return res.json({
            received: true
          });
        }

        const { error } =
          await supabase
            .from("pixels")
            .insert({
              x: Number(x),
              y: Number(y),
              color,
              username,
              stripe_session_id:
                session.id
            });

        if (error) {

          console.error(
            "Pixel insert error:",
            error
          );

          return res.status(500).json({
            error: "Database error"
          });
        }

        await supabase
          .from("pixel_reservations")
          .delete()
          .eq("x", Number(x))
          .eq("y", Number(y))
          .eq(
            "session_id",
            session.id
          );
      }

      if (
        event.type ===
        "checkout.session.expired"
      ) {

        const session =
          event.data.object;

        await supabase
          .from("pixel_reservations")
          .delete()
          .eq(
            "session_id",
            session.id
          );
      }

    } catch (error) {

      console.error(
        "Webhook processing error:",
        error
      );

      return res.status(500).json({
        error: "Webhook processing failed"
      });
    }

    res.json({
      received: true
    });
  }
);

app.use(express.json());

/* ---------------- PIXELS ---------------- */

app.get("/api/pixels", async (req, res) => {

  const { data, error } =
    await supabase
      .from("pixels")
      .select(
        "x,y,color,username"
      );

  if (error) {

    return res.status(500).json({
      error: error.message
    });
  }

  res.json(data || []);
});

/* ---------------- ONE PIXEL ---------------- */

app.get(
  "/api/pixel/:x/:y",
  async (req, res) => {

    const x = Number(req.params.x);
    const y = Number(req.params.y);

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= SIZE ||
      y >= SIZE
    ) {

      return res.status(400).json({
        error: "Invalid coordinates"
      });
    }

    const { data, error } =
      await supabase
        .from("pixels")
        .select("*")
        .eq("x", x)
        .eq("y", y)
        .maybeSingle();

    if (error) {

      return res.status(500).json({
        error: error.message
      });
    }

    if (!data) {

      return res.status(404).json({
        error: "Pixel is free"
      });
    }

    res.json(data);
  }
);

/* ---------------- STATS ---------------- */

app.get("/api/stats", async (req, res) => {

  const { count, error } =
    await supabase
      .from("pixels")
      .select("*", {
        count: "exact",
        head: true
      });

  if (error) {

    return res.status(500).json({
      error: error.message
    });
  }

  const claimed = count || 0;

  res.json({

    claimed,

    remaining:
      SIZE * SIZE - claimed,

    raisedCents:
      claimed * PRICE_CENTS,

    priceCents:
      PRICE_CENTS,

    currency:
      CURRENCY
  });
});

/* ---------------- LEADERBOARD ---------------- */

app.get(
  "/api/leaderboard",
  async (req, res) => {

    const { data, error } =
      await supabase
        .from("pixels")
        .select("username");

    if (error) {

      return res.status(500).json({
        error: error.message
      });
    }

    const counts = {};

    for (const pixel of data || []) {

      counts[pixel.username] =
        (counts[pixel.username] || 0) + 1;
    }

    const leaderboard =
      Object.entries(counts)
        .map(
          ([username, count]) => ({
            username,
            count
          })
        )
        .sort(
          (a, b) =>
            b.count - a.count
        )
        .slice(0, 20);

    res.json(leaderboard);
  }
);

/* ---------------- CHECKOUT ---------------- */

app.post(
  "/api/checkout",
  async (req, res) => {

    try {

      const {
        x,
        y,
        color,
        username
      } = req.body;

      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= SIZE ||
        y >= SIZE
      ) {

        return res.status(400).json({
          error: "Invalid pixel"
        });
      }

      if (
        typeof username !== "string" ||
        username.length < 2 ||
        username.length > 20
      ) {

        return res.status(400).json({
          error:
            "Username must be 2–20 characters"
        });
      }

      if (
        typeof color !== "string" ||
        !/^#[0-9a-fA-F]{6}$/.test(color)
      ) {

        return res.status(400).json({
          error: "Invalid color"
        });
      }

      const { data: existing } =
        await supabase
          .from("pixels")
          .select("x")
          .eq("x", x)
          .eq("y", y)
          .maybeSingle();

      if (existing) {

        return res.status(409).json({
          error: "This pixel is already owned"
        });
      }

      const session =
        await stripe.checkout.sessions.create({

          mode: "payment",

          line_items: [
            {
              price_data: {

                currency: CURRENCY,

                product_data: {
                  name:
                    `Pixel ${x},${y}`
                },

                unit_amount:
                  PRICE_CENTS
              },

              quantity: 1
            }
          ],

          metadata: {
            x: String(x),
            y: String(y),
            color,
            username
          },

          success_url:
            `${process.env.PUBLIC_URL}/?success=1`,

          cancel_url:
            `${process.env.PUBLIC_URL}/?cancelled=1`
        });

      /*
        Reserve the pixel so two people
        cannot buy it simultaneously.
      */

      const { error: reserveError } =
        await supabase
          .from("pixel_reservations")
          .insert({

            x,
            y,
            color,
            username,
            session_id:
              session.id,

            expires_at:
              new Date(
                Date.now() +
                30 * 60 * 1000
              ).toISOString()
          });

      if (reserveError) {

        await stripe.checkout.sessions.expire(
          session.id
        );

        return res.status(409).json({
          error:
            "This pixel is already being purchased."
        });
      }

      res.json({
        url: session.url
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not create checkout session"
      });
    }
  }
);

/* ---------------- WEBSITE ---------------- */

app.use(
  express.static("public")
);

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      "index.html",
      {
        root: "public"
      }
    );
  }
);

/* ---------------- START ---------------- */

app.listen(
  PORT,
  () => {

    console.log(
      `PixelArtWorld running on port ${PORT}`
    );

  }
);
