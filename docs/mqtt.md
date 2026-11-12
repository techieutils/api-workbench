---
description: Connect to an MQTT broker, subscribe to topic filters, and publish messages with QoS and retain.
icon: access-point-network
---

# MQTT

## Connect

1. Choose **MQTT** under **Live protocols** in the select at the start of the URL bar.
2. Enter the broker URL: `mqtt://` (port 1883 by default), `mqtts://` for TLS (port 8883), or `ws://` and `wss://` for MQTT over WebSocket, such as `wss://broker.example.com/mqtt`.
3. In **Topics**, list the topic filters to subscribe to. `+` matches one level and `#` everything below, so `sensors/+/temperature` matches `sensors/kitchen/temperature`. Each filter has its own **QoS**; turn a row off to keep it without subscribing.
4. Click **Connect**. The timeline shows each subscription the broker granted or refused.

New MQTT requests subscribe to `#`, every topic. Change it before connecting to a busy broker.

## Publish

1. Enter the topic in **Publish to**, below the URL. Topics you publish to cannot contain `+` or `#`.
2. Choose **QoS 0** (at most once), **QoS 1** (at least once), or **QoS 2** (exactly once), and turn on **Retain** to have the broker keep the message for future subscribers.
3. Write the payload in **Message** and click **Publish**. Turn on **Binary (base64)** to publish base64 text as bytes.

## Receive

Messages on your subscriptions appear in the response with their topic. Text payloads are shown as text, and anything that is not UTF-8 as base64. In **Timeline**, right-click a message and choose **Use as next message** to load it into the editor, with its topic in **Publish to**, or **Send again** to publish a sent message to the same topic once more.

## Session settings

In **Settings**:

| Setting              | What it does                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Client ID**        | How the broker identifies you. Empty generates `api-workbench-…`. A second client with the same ID disconnects the first. |
| **Protocol version** | **MQTT 3.1.1** (default) or **MQTT 5**.                                                                                   |
| **Keep-alive**       | Seconds between pings, 60 by default; 0 turns it off.                                                                     |
| **Clean start**      | On (default) begins a new session; off asks the broker to resume the last one with this client ID.                        |

## Authorization

Brokers take a username and password, so choose **Basic auth** — or a saved Basic credential — in **Auth**. The username and password go in the MQTT connection request, not in a header. A saved credential's origin is the broker as HTTP: `http://broker:1883` for `mqtt://broker`, and `https://broker:8883` for `mqtts://broker`.

Over `ws://` and `wss://`, headers in **Headers** and header-based auth (Bearer, API key, signing) are sent with the WebSocket handshake too. Over `mqtt://` and `mqtts://` there is no handshake for headers, so other auth types are refused.

[Client certificates](client-certificates.md) are presented on `mqtts://` and `wss://` connections whose host and port match.

> [!NOTE]
> [Proxy settings](settings.md#proxy) apply to MQTT over WebSocket. `mqtt://` and `mqtts://` connect directly, and the timeline says so when a proxy is configured. API Workbench does not reconnect automatically; click **Connect** again.

## Generate a client

**Code** produces the connection as `mosquitto_pub` and `mosquitto_sub`, Node.js (MQTT.js), or Python (`paho-mqtt`), with your subscriptions, topic, QoS, retain, and username — see [Code snippets](code-snippets.md#realtime-protocols).
