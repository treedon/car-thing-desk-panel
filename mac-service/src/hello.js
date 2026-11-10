// What a client is told the moment it says hello, so it need not wait for the
// next change to learn what the service already knows. Kept out of index.js
// (which starts servers when imported) so a test can check it.

// [[topic, data], ...] in the order they are sent.
export function helloEvents({ queueSnapshot, macPower }) {
  return [
    // The whole waiting list, so a screen that watched the last daemon die stops
    // showing asks this one has never heard of.
    ['claude.queue.sync', queueSnapshot()],
    // The Mac's display and sleep state. After a service restart the panel
    // has lost it, and the display may well still be off.
    ['claude.mac.power', macPower.get()],
  ];
}
