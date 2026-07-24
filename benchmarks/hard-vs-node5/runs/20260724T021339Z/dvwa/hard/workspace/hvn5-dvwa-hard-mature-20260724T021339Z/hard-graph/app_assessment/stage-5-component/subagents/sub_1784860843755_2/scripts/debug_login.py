import requests
import re

s = requests.Session()

# Get login page
r = s.get('http://127.0.0.1:8080/login.php')

# Extract user_token
match = re.search(r'name=["\']user_token["\'][^>]*value=["\']([^"\']+)', r.text)
user_token = match.group(1) if match else ''
print("user_token:", user_token)

# Try login
login_data = {
    'username': 'admin',
    'password': 'password',
    'Login': 'Login',
    'user_token': user_token
}
print("Login data:", login_data)

r = s.post('http://127.0.0.1:8080/login.php', data=login_data)
print("Status:", r.status_code)
print("URL:", r.url)

# Check for error message
if 'Login failed' in r.text or 'failed' in r.text:
    print("Login failed detected")
    
# Print relevant parts
if 'alert' in r.text:
    alerts = re.findall(r'<div[^>]*class=["\']?message["\']?[^>]*>(.*?)</div>', r.text, re.DOTALL)
    print("Messages:", alerts)

# Print the response around the form area
form_match = re.search(r'<form.*?</form>', r.text, re.DOTALL)
if form_match:
    print("Form area:", form_match.group(0)[:500])
else:
    print("No form found")
    # Print body
    print(r.text[1000:2000])
