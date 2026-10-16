"""Optional browser tests against an explicitly configured disposable server."""
import os
import time

import pytest
from selenium.webdriver import Firefox
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select, WebDriverWait


@pytest.mark.needs_server
class TestMaxlifeFeature:
    def setup_class(self):
        self.base_url = os.environ.get('BEPASTY_TEST_URL')
        if not self.base_url:
            pytest.skip('Set BEPASTY_TEST_URL to a disposable passwordless test server')
        options = Options()
        options.add_argument('-headless')
        self.browser = Firefox(options=options)
        self.wait = WebDriverWait(self.browser, 20)

    def teardown_class(self):
        if hasattr(self, 'browser'):
            self.browser.quit()

    @property
    def page_body_lowercase(self):
        return self.browser.find_element(By.TAG_NAME, 'body').text.lower()

    def test_unit_input_exists(self):
        self.browser.get(self.base_url)
        self.wait.until(lambda b: b.find_element(By.ID, 'shared-maxlife').is_displayed())

    def fill_form(self, lifetime_unit='forever'):
        filename, text = 'test.txt', 'This is a test'
        self.browser.get(self.base_url)
        self.wait.until(lambda b: b.find_element(By.ID, 'shared-maxlife').is_displayed())
        Select(self.browser.find_element(By.ID, 'shared-maxlife')).select_by_value(lifetime_unit + ':1')
        self.browser.find_element(By.ID, 'formupload').send_keys(text)
        self.browser.find_element(By.ID, 'filename').send_keys(filename)
        self.browser.find_element(By.ID, 'formupload-submit').click()
        link = self.wait.until(lambda b: b.find_element(By.CSS_SELECTOR, '#files .share-link input'))
        self.browser.get(link.get_attribute('value'))
        self.wait.until(lambda b: b.find_element(By.ID, 'inline-btn'))
        return filename, text

    def delete_current_file(self):
        self.browser.find_element(By.CSS_SELECTOR, '[data-detail-view=manage]').click()
        self.browser.find_element(By.ID, 'del-btn').click()
        self.browser.switch_to.alert.accept()
        self.wait.until(lambda b: '/+list' in b.current_url)

    def test_paste_keep_forever(self):
        self.fill_form()
        assert '永久保留' in self.page_body_lowercase
        self.delete_current_file()

    def test_paste_keep_minutes(self):
        self.fill_form('minutes')
        assert '永久保留' not in self.browser.find_element(By.CSS_SELECTOR, '.file-overview').text
        self.delete_current_file()

    def test_filename_gets_displayed(self):
        filename, _ = self.fill_form()
        assert filename in self.page_body_lowercase
        self.delete_current_file()

    def test_pasted_text_gets_displayed(self):
        _, text = self.fill_form()
        assert text.lower() in self.page_body_lowercase
        self.delete_current_file()

    @pytest.mark.slow
    def test_file_gets_deleted_after_expiry_time(self):
        self.fill_form('minutes')
        time.sleep(61)
        self.browser.find_element(By.ID, 'inline-btn').click()
        assert '不存在' in self.page_body_lowercase
