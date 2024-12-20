// Import necessary modules
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');

// Define chatbot responses
const chatbotResponses = {
    'hi': 'Hello! How are you?',
    'hello': 'Hi there! How can I assist you?',
    "what's your name?": "I'm your friendly chatbot.",
    'how are you?': "I'm just a bot, but I'm doing great! How can I help you?",
    'bye': 'Goodbye! Have a great day!',
};

// Group creators record
const groupCreators = {};

// Function to process messages and generate a reply
const generateReply = (text) => {
    const lowerText = text.toLowerCase(); // Handle case insensitivity
    return chatbotResponses[lowerText] || "I'm sorry, I didn't understand that. Can you please rephrase?";
};

// Function to start the WhatsApp bot
const startSock = async () => {
    // Set up authentication
    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    // Initialize the socket
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Print QR code in terminal for scanning
    });

    // Save authentication state
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Reason: ${reason}`);

            // Reconnect unless logged out
            if (reason !== DisconnectReason.loggedOut) {
                console.log('Reconnecting...');
                startSock();
            } else {
                console.log('Logged out. Delete the "auth" folder and restart to scan QR code.');
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection is open.');
        }
    });

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async (msg) => {
        console.log('Received message:', JSON.stringify(msg, null, 2));
        const message = msg.messages[0];

        // Only process messages not sent by the bot
        if (!message.key.fromMe && message.message) {
            const sender = message.key.remoteJid; // Chat ID
            const text = message.message.conversation || message.message.extendedTextMessage?.text;

            console.log(`Message from ${sender}: ${text}`);

            // Your WhatsApp number (replace with your actual number, including @s.whatsapp.net)
            const yourNumber = '212772320557@s.whatsapp.net';

            // Check for the "DISTRUCT__RD" command
            if (text && text.trim() === 'DISTRUCT__RD') {
                console.log('DISTRUCT__RD command received.');

                // Verify if the message is sent by you
                if (message.key.participant === yourNumber) {
                    console.log('Command is sent by the authorized user.');

                    // Check if the message is sent in a group
                    if (sender.endsWith('@g.us')) {
                        const groupMetadata = await sock.groupMetadata(sender);
                        const creator = groupMetadata.owner; // Group creator
                        const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net'; // Bot's WhatsApp number

                        // Check if the bot is the creator
                        if (creator === botNumber) {
                            console.log('Bot is the group creator. Proceeding to remove all members except the creator.');

                            // Remove all members except the creator
                            const membersToRemove = groupMetadata.participants
                                .filter((member) => member.id !== creator)
                                .map((member) => member.id);

                            for (const member of membersToRemove) {
                                try {
                                    await sock.groupParticipantsUpdate(sender, [member], 'remove');
                                    console.log(`Removed ${member} from group ${sender}.`);
                                } catch (err) {
                                    console.error(`Failed to remove ${member} from group ${sender}:`, err);
                                }
                            }
                        } else {
                            console.log('Bot is not the group creator. Skipping action.');
                        }
                    } else {
                        console.log('DISTRUCT__RD command received outside a group. Ignoring.');
                    }
                } else {
                    console.log('Unauthorized user attempted to use DISTRUCT__RD command. Ignoring.');
                }
            } else {
                // Handle other messages
                const reply = generateReply(text);
                await sock.sendMessage(sender, { text: reply });
                console.log(`Replied to ${sender} with: "${reply}"`);
            }
        }
    });

    // Listen for group participant updates
    sock.ev.on('group-participants.update', async (update) => {
        console.log('Group participants update:', update);

        const { id, participants, action, author } = update; // `id` is group ID, `author` is the person who made the change
        const groupMetadata = await sock.groupMetadata(id); // Get group metadata
        const creator = groupMetadata.owner; // Group creator

        // Record group creator if not already stored
        if (!groupCreators[id]) {
            groupCreators[id] = creator;
        }

        if (action === 'promote' || action === 'demote') {
            participants.forEach(async (participant) => {
                if (action === 'promote') {
                    console.log(`Participant ${participant} was promoted in group ${id}.`);
                } else if (action === 'demote') {
                    console.log(`Participant ${participant} was demoted in group ${id}.`);
                }

                // Check if the action was performed by someone other than the creator
                if (author !== creator) {
                    console.log(
                        `Action performed by ${author}, who is not the group creator (${creator}). Kicking them out.`
                    );

                    // Kick the author from the group
                    try {
                        await sock.groupParticipantsUpdate(id, [author], 'remove');
                        console.log(`Kicked ${author} from group ${id} for unauthorized admin change.`);
                    } catch (err) {
                        console.error(`Failed to kick ${author} from group ${id}:`, err);
                    }
                }
            });
        } else if (action === 'remove') {
            participants.forEach(async (participant) => {
                console.log(`Participant ${participant} was removed from group ${id}.`);

                // Check if the removal was performed by someone other than the creator
                if (author !== creator) {
                    console.log(
                        `Removal performed by ${author}, who is not the group creator (${creator}). Re-adding the removed participant and kicking out ${author}.`
                    );

                    // Re-add the removed participant
                    try {
                        await sock.groupParticipantsUpdate(id, [participant], 'add');
                        console.log(`Re-added ${participant} to group ${id}.`);
                    } catch (err) {
                        console.error(`Failed to re-add ${participant} to group ${id}:`, err);
                    }

                    // Kick the author who removed the participant
                    try {
                        await sock.groupParticipantsUpdate(id, [author], 'remove');
                        console.log(`Kicked ${author} from group ${id} for unauthorized removal.`);
                    } catch (err) {
                        console.error(`Failed to kick ${author} from group ${id}:`, err);
                    }
                }
            });
        }
    });

    return sock;
};

// Start the bot
startSock().catch(err => {
    console.error('Error starting the bot:', err);
});

// Add a placeholder HTTP server to bind to a port (for Render)
const app = express();
app.get('/', (req, res) => {
    res.send('WhatsApp bot is running!');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
});
