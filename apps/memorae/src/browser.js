/**
 * Browser Automation module for Jarvis
 * Uses Puppeteer for headless Chrome automation
 * Supports: navigate, screenshot, click, type, extract text, fill forms
 */
const path = require('path');

const CHROME_PATH = '/root/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';
const MAX_TIMEOUT = 30000;

let puppeteer = null;
let StealthPlugin = null;

function loadPuppeteer() {
  if (!puppeteer) {
    puppeteer = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  }
  return puppeteer;
}

/**
 * Create a browser instance
 */
async function createBrowser() {
  const pptr = loadPuppeteer();
  return pptr.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
    timeout: MAX_TIMEOUT,
  });
}

/**
 * Browse a URL — navigate, extract text, optionally take screenshot
 * @param {string} url - URL to visit
 * @param {object} options - { screenshot: bool, waitFor: string (selector), extract: string (selector), timeout: number }
 * @returns {{ title, url, text, screenshot?: Buffer }}
 */
async function browse(url, options = {}) {
  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: options.timeout || MAX_TIMEOUT 
    });
    
    // Wait for specific element if requested
    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: 10000 }).catch(() => {});
    }
    
    // Extract text
    let text;
    if (options.extract) {
      text = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText : null;
      }, options.extract);
    } else {
      text = await page.evaluate(() => {
        // Remove noise
        const remove = document.querySelectorAll('script, style, nav, footer, header, iframe, noscript');
        remove.forEach(el => el.remove());
        return document.body.innerText.substring(0, 8000);
      });
    }
    
    const title = await page.title();
    const finalUrl = page.url();
    
    // Screenshot if requested
    let screenshot = null;
    if (options.screenshot) {
      screenshot = await page.screenshot({ 
        type: 'jpeg', 
        quality: 70,
        fullPage: false 
      });
    }
    
    await browser.close();
    return { title, url: finalUrl, text: text || '', screenshot };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { error: err.message };
  }
}

/**
 * Fill a form on a webpage
 * @param {string} url - URL with the form
 * @param {Array} fields - [{ selector: "input#email", value: "test@example.com", type: "type" }]
 * @param {string} submitSelector - Button/element to click to submit
 * @returns {{ success, resultUrl, resultText, screenshot? }}
 */
async function fillForm(url, fields, submitSelector, options = {}) {
  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: MAX_TIMEOUT });
    
    // Fill each field
    for (const field of fields) {
      if (field.type === 'select') {
        await page.select(field.selector, field.value);
      } else if (field.type === 'click') {
        await page.click(field.selector);
      } else {
        // Clear and type
        await page.click(field.selector, { clickCount: 3 });
        await page.type(field.selector, field.value, { delay: 30 });
      }
      await new Promise(r => setTimeout(r, 300));
    }
    
    // Submit
    if (submitSelector) {
      await page.click(submitSelector);
      await new Promise(r => setTimeout(r, 3000));
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    }
    
    const resultUrl = page.url();
    const resultText = await page.evaluate(() => document.body.innerText.substring(0, 4000));
    
    let screenshot = null;
    if (options.screenshot) {
      screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
    }
    
    await browser.close();
    return { success: true, resultUrl, resultText, screenshot };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { error: err.message };
  }
}

/**
 * Take a screenshot of a URL
 */
async function screenshot(url) {
  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: MAX_TIMEOUT });
    const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
    const title = await page.title();
    await browser.close();
    return { screenshot: buf, title };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { error: err.message };
  }
}

/**
 * Click an element and return the result
 */
async function clickElement(url, selector, options = {}) {
  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: MAX_TIMEOUT });
    
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    await new Promise(r => setTimeout(r, 2000));
    
    const text = await page.evaluate(() => document.body.innerText.substring(0, 4000));
    const finalUrl = page.url();
    
    let screenshotBuf = null;
    if (options.screenshot) {
      screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 70 });
    }
    
    await browser.close();
    return { url: finalUrl, text, screenshot: screenshotBuf };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { error: err.message };
  }
}

module.exports = { browse, fillForm, screenshot, clickElement };
