const ngrok = require('ngrok');

(async function () {
    try {
        await ngrok.kill();
        await new Promise(resolve => setTimeout(resolve, 2000));
        const url = await ngrok.connect({
            proto: 'http',
            addr: 3000,
            authtoken: '37A9G5e7KaZtwEoFGvy8IyGVzQz_5hz4wG9L6fn2ZLDZCukEK',
        });
        console.log(`Ngrok tunnel open at: ${url}`);
        console.log('You can now use this URL as your webhook endpoint or for remote access.');
    } catch (err) {
        console.error('Error starting ngrok:', err);
    }
})();
